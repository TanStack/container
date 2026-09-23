import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {resolve,sep,extname} from 'node:path'
import {spawnSync} from 'node:child_process'

const root=realpathSync(process.env.SDK_OUTPUT)
const source=readFileSync('tests/fixtures/node-sqlite.mjs','utf8')
let server,url
test.beforeAll(async()=>{
 server=createServer((req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname
  if(path==='/'){res.setHeader('content-type','text/html');res.end('<script type="module">import * as sdk from "/sdk/index.js";window.sdk=sdk</script>');return}
  try{
   if(!path.startsWith('/sdk/'))throw Error('Outside SDK')
   const file=realpathSync(resolve(root,decodeURIComponent(path.slice(5))))
   if(!file.startsWith(root+sep))throw Error('Outside SDK')
   res.setHeader('content-type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'})[extname(file)]??'application/octet-stream')
   res.end(readFileSync(file))
  }catch{res.statusCode=404;res.end()}
 })
 await new Promise(done=>server.listen(0,'127.0.0.1',done));url=`http://127.0.0.1:${server.address().port}`
})
test.afterAll(async()=>{if(server)await new Promise(done=>server.close(done))})

for(const kind of ['module','commonjs'])for(const indirect of [false,true])test(`packaged in-memory SQLite ${kind} ${indirect?'transitive':'direct'} row modes match native Node`,async({page},info)=>{
 const entry=kind==='module'?'/main.mjs':'/main.cjs'
 const entrySource=kind==='module'?source:source.replace("import {DatabaseSync} from 'node:sqlite'","const {DatabaseSync}=require('node:sqlite')")
 const native=spawnSync(process.execPath,['--input-type='+kind,'-e',entrySource],{encoding:'utf8',timeout:15000,maxBuffer:128*1024})
 expect(native.status,native.stderr||String(native.error??'')).toBe(0)
 await page.goto(url);await page.waitForFunction(()=>!!window.sdk)
 const guest=await page.evaluate(async({entry,source,indirect,kind})=>{
  const dependency=kind==='module'?'/queries.mjs':'/queries.cjs'
  const files=indirect?{[entry]:kind==='module'?"import './queries.mjs';":"require('./queries.cjs');",[dependency]:source}:{[entry]:source}
  const kernel=new window.sdk.WorkerKernel(files,{experimentalFibers:true,maxBytes:64*1024*1024})
  try{return await kernel.runModule(entry,{guestWasm:true,maxBytes:64*1024*1024,timeoutMs:15000})}
  finally{kernel.close()}
 },{entry,source:entrySource,indirect,kind})
 await info.attach('node-sqlite.json',{body:JSON.stringify({sdk:root,scope:'In-memory SQLite only, statement array/object modes and existing basic queries',native:{version:process.version,status:native.status,stdout:native.stdout,stderr:native.stderr},guest},null,2),contentType:'application/json'})
 expect(guest.exitCode,guest.stderr).toBe(0)
 expect(JSON.parse(guest.stdout)).toEqual(JSON.parse(native.stdout))
})

test('packaged SQLite retains explicit guest WASM requirement',async({page})=>{
 await page.goto(url);await page.waitForFunction(()=>!!window.sdk)
 const result=await page.evaluate(async()=>{
  const kernel=new window.sdk.WorkerKernel({'/main.mjs':"import {DatabaseSync} from 'node:sqlite';new DatabaseSync(':memory:');"},{experimentalFibers:true})
  try{return await kernel.runModule('/main.mjs',{timeoutMs:15000})}finally{kernel.close()}
 })
 expect(result.exitCode).toBe(1)
 expect(result.stderr).toContain('node:sqlite requires guestWasm')
})
