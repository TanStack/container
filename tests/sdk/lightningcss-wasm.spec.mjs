import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,sep,extname} from 'node:path'
import {spawnSync} from 'node:child_process'
import {collectInstalledClosure} from '../../scripts/collect-installed-closure.mjs'

const root=realpathSync(process.env.SDK_OUTPUT)
const fixture=resolve('fixtures/lightningcss-wasm')
let server,url,snapshot
test.beforeAll(async()=>{
  snapshot=JSON.stringify(await collectInstalledClosure(fixture,['lightningcss-wasm']))
  server=createServer((req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname
    if(path==='/'){res.setHeader('content-type','text/html');res.end('<script type="module">import * as sdk from "/sdk/index.js";window.sdk=sdk</script>');return}
    if(path==='/fixture.json'){res.setHeader('content-type','application/json');res.end(snapshot);return}
    try{
      if(!path.startsWith('/sdk/'))throw Error('outside package')
      const file=realpathSync(resolve(root,decodeURIComponent(path.slice(5))))
      if(!file.startsWith(root+sep))throw Error('outside package')
      res.setHeader('content-type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'})[extname(file)]??'application/octet-stream')
      res.end(readFileSync(file))
    }catch{res.statusCode=404;res.end()}
  })
  await new Promise(done=>server.listen(0,'127.0.0.1',done))
  url=`http://127.0.0.1:${server.address().port}`
})
test.afterAll(async()=>{if(server)await new Promise(done=>server.close(done))})

for(const sample of [
  {name:'simple',css:'.card { color: #ff0000; margin: 0px 0px 0px 0px; display: flex; }'},
  {name:'nesting',css:'.card { color: red; & > .title { color: blue; padding: 0px; } }'},
])test(`packaged Lightning CSS transforms ${sample.name} with native code and sourcemap parity`,async({page},info)=>{
  const source=`function phase(name){
 const evidence={phase:name,memoryUsageSupported:typeof process.memoryUsage==='function'};
 if(evidence.memoryUsageSupported)try{
  const usage=process.memoryUsage();evidence.memoryUsage={};evidence.unavailableMemoryFields={};
  for(const key of Object.keys(usage))try{evidence.memoryUsage[key]=usage[key]}catch(error){evidence.unavailableMemoryFields[key]={name:error.name,message:error.message}}
 }catch(error){evidence.memoryUsageError={name:error.name,message:error.message}}
 console.error('LIGHTNINGCSS_PHASE '+JSON.stringify(evidence));
}
phase('before require');
const {transform}=require('lightningcss-wasm');
phase('after require');
const result=transform({filename:${JSON.stringify(sample.name+'.css')},code:Buffer.from(${JSON.stringify(sample.css)}),minify:true,sourceMap:true,targets:{chrome:80<<16}});
phase('after transform');
console.log(JSON.stringify({code:Array.from(result.code),map:JSON.parse(Buffer.from(result.map).toString()),warnings:result.warnings,exports:result.exports,dependencies:result.dependencies}));`
  const phases=text=>(text??'').split('\n').filter(line=>line.startsWith('LIGHTNINGCSS_PHASE ')).map(line=>JSON.parse(line.slice('LIGHTNINGCSS_PHASE '.length)))
  const native=spawnSync(process.execPath,['-e',source],{cwd:fixture,encoding:'utf8',timeout:15000})
  const nativePath=info.outputPath('native-lightningcss.json')
  await writeFile(nativePath,JSON.stringify({status:native.status,signal:native.signal,error:native.error?.message,phases:phases(native.stderr),stdout:native.stdout,stderr:native.stderr},null,2))
  await info.attach('native-lightningcss.json',{path:nativePath,contentType:'application/json'})
  expect(native.status,native.stderr||native.error?.message).toBe(0)
  const expected=JSON.parse(native.stdout)
  expect(expected.code.length).toBeGreaterThan(0)
  expect(expected.map.version).toBe(3)
  expect(expected.map.sourcesContent).toEqual([sample.css])
  expect(expected.warnings).toEqual([])
  if(sample.name==='nesting')expect(Buffer.from(expected.code).toString()).not.toContain('&')
  await page.goto(url);await page.waitForFunction(()=>Boolean(window.sdk))
  const execution=await page.evaluate(async source=>{
    const evidence={result:null,error:null,output:[]};let kernel
    try{
      const snapshot=await fetch('/fixture.json').then(r=>r.json())
      const files=Object.fromEntries(Object.entries(snapshot.files).map(([path,value])=>['/project'+path,Uint8Array.from(atob(value.base64),char=>char.charCodeAt(0))]))
      files['/project/main.cjs']=source
      kernel=new window.sdk.WorkerKernel(files,{experimentalFibers:true,maxBytes:128*1024*1024,timeoutMs:15000,workspace:{maxBytes:64*1024*1024}})
      evidence.result=await kernel.runModule('/project/main.cjs',{cwd:'/project',guestWasm:true,webAPIs:true,maxBytes:128*1024*1024,timeoutMs:15000,onOutput:(level,text)=>evidence.output.push({level,text})})
    }catch(error){evidence.error={name:error.name,message:error.message,stack:error.stack}}
    finally{if(kernel)kernel.close()}
    return evidence
  },source)
  const evidencePath=info.outputPath('packaged-lightningcss.json')
  await writeFile(evidencePath,JSON.stringify({sdk:root,version:JSON.parse(readFileSync(resolve(fixture,'node_modules/lightningcss-wasm/package.json'),'utf8')).version,sample,expected,phases:phases(execution.result?.stderr??execution.output.map(item=>item.text).join('\n')),...execution},null,2))
  await info.attach('packaged-lightningcss.json',{path:evidencePath,contentType:'application/json'})
  expect(execution.error,JSON.stringify(execution)).toBeNull()
  expect(execution.result.exitCode,execution.result.stderr||execution.result.stdout).toBe(0)
  expect(JSON.parse(execution.result.stdout)).toEqual(expected)
})
