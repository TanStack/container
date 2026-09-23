import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,sep,extname} from 'node:path'
import {spawnSync} from 'node:child_process'
import {inspectionCases} from '../../fixtures/inspection-cases.mjs'

const root=realpathSync(process.env.SDK_OUTPUT)
const policy={experimentalFibers:true,maxBytes:64*1024*1024,timeoutMs:15000}
const cases=[
 ['mutated formatter defaults remain local to one guest process',`import {inspect} from 'node:util';inspect.defaultOptions.depth=99;console.log(inspect.defaultOptions.depth);`],
 ['fresh guest process restores formatter defaults',`import {inspect} from 'node:util';import assert from 'node:assert/strict';assert.equal(inspect.defaultOptions.depth,2);console.log(inspect.defaultOptions.depth);`],
 ...Object.entries(inspectionCases),
].map(([name,source],index)=>({name,source,path:`/project/case-${index}.mjs`}))
let server,url
test.beforeAll(async()=>{
 server=createServer((req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname
  if(path==='/'){res.setHeader('content-type','text/html');res.end('<script type="module">import * as sdk from "/sdk/index.js";window.sdk=sdk</script>');return}
  try{if(!path.startsWith('/sdk/'))throw Error();const file=realpathSync(resolve(root,decodeURIComponent(path.slice(5))));if(!file.startsWith(root+sep))throw Error();res.setHeader('content-type',({'.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.wasm':'application/wasm'})[extname(file)]??'application/octet-stream');res.end(readFileSync(file))}catch{res.statusCode=404;res.end()}
 })
 await new Promise(done=>server.listen(0,'127.0.0.1',done));url=`http://127.0.0.1:${server.address().port}`
})
test.afterAll(async()=>{if(server)await new Promise(done=>server.close(done))})

test('inspection startup preserves Node formatting and fresh-process default isolation',async({page},info)=>{
 test.setTimeout(60000)
 const rows=[];let workflowError,cleanup
 try{
  // Playwright forces reporter colors in its child environment. Native
  // reference stdout is a pipe, matching the guest's non-TTY stdout.
  const referenceEnv={...process.env,NO_COLOR:'1'};delete referenceEnv.FORCE_COLOR
  const references=cases.map(sample=>{
   const result=spawnSync(process.execPath,['--input-type=module','-e',sample.source],{env:referenceEnv,encoding:'utf8',timeout:15000,maxBuffer:128*1024})
   return {name:sample.name,status:result.status,stdout:result.stdout,stderr:result.stderr,error:result.error?.message}
  })
  await page.goto(url);await page.waitForFunction(()=>!!window.sdk)
  await page.evaluate(({files,policy})=>{window.inspectionStartup={kernel:new window.sdk.WorkerKernel(files,policy),rows:[]}}, {files:Object.fromEntries(cases.map(sample=>[sample.path,sample.source])),policy})
  for(let index=0;index<cases.length;index++){
   const sample=cases[index],native=references[index],row={name:sample.name,native};rows.push(row)
   expect(native.status,native.stderr||native.error).toBe(0)
   row.guest=await page.evaluate(async({path,maxBytes})=>{
    const state=window.inspectionStartup,startedAt=performance.now()
    const result=await state.kernel.runModule(path,{cwd:'/project',guestWasm:true,webAPIs:true,diagnostics:true,maxBytes,timeoutMs:15000})
    const startup=state.kernel.jobProfile.filter(row=>row.phase==='process-startup-timeline'||row.phase==='inspection-initializer').slice(0,64)
    state.kernel.jobProfile.length=0
    const row={result,elapsedMs:performance.now()-startedAt,startup};state.rows.push(row);return row
   },{path:sample.path,maxBytes:policy.maxBytes})
   expect(row.guest.result.exitCode,row.guest.result.stderr).toBe(native.status)
   expect(row.guest.result.stdout).toBe(native.stdout)
  }
 }catch(error){workflowError=String(error);throw error}
 finally{
  try{cleanup=await page.evaluate(()=>{const state=window.inspectionStartup;if(!state)return {missingState:true};const startup=state.kernel.jobProfile.filter(row=>row.phase==='process-startup-timeline').slice(0,64);let error;try{state.kernel.close()}catch(cause){error=String(cause)}return {startup,error}})}catch(error){cleanup={error:String(error)}}
  // Fixture output is small. Cap retained diagnostic text without weakening comparisons above.
  const boundedRows=rows.map(row=>({...row,native:{...row.native,stdout:row.native.stdout?.slice(0,32768),stderr:row.native.stderr?.slice(0,32768)},...(row.guest?{guest:{...row.guest,result:{...row.guest.result,stdout:row.guest.result.stdout?.slice(0,32768),stderr:row.guest.result.stderr?.slice(0,32768)}}}:{})}))
  const path=info.outputPath('inspection-startup.json');await writeFile(path,JSON.stringify({sdk:root,policy,scope:'Twenty successive fresh guest processes in one kernel, independent native reference processes',workflowError,rows:boundedRows,cleanup},null,2));await info.attach('inspection-startup.json',{path,contentType:'application/json'})
  if(!workflowError)expect(cleanup?.error).toBeUndefined()
 }
})
