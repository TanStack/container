import {test,expect} from '@playwright/test'
import {createServer,type Server} from 'node:http'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'

// Fixture is shared with the native oracle driver, without a generated baseline.
const {cases}=await import('../../fixtures/generator-resume-cases.mjs' as string) as {cases:{name:string;source:string}[]}
const engine=resolve('public/quickjs-als-generator-resume')
const workerSource=`
self.onmessage=async({data})=>{
  let runtime,context;
  try{
    const base=new URL('./',self.location.href);
    const metadata=await(await fetch(new URL('build.json',base))).json();
    if(metadata.generatorResume?.scope!=='direct intrinsic generator calls')throw Error('Missing generator resume metadata');
    const bytes=await(await fetch(new URL('engine.wasm',base))).arrayBuffer();
    const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
    if(digest!==data.wasmSHA256||digest!==metadata.wasmSha256)throw Error('WASM hash mismatch');
    const wrapper=await import(new URL('core.mjs',base));
    const factory=(await import(new URL('engine.mjs',base))).default;
    const QuickJSFFI=(await import(new URL('ffi.mjs',base))).QuickJSFFI;
    const module=await wrapper.newQuickJSWASMModuleFromVariant({type:'sync',importFFI:async()=>QuickJSFFI,importModuleLoader:async()=>()=>factory({wasmBinary:bytes})});
    runtime=module.newRuntime();runtime.setMemoryLimit(64*1024*1024);runtime.setMaxStackSize(512*1024);
    const deadline=performance.now()+5000;runtime.setInterruptHandler(()=>performance.now()>deadline);
    context=runtime.newContext();
    const evaluate=source=>{const result=context.evalCode(source,'generator-case.js');try{if(result.error)throw Error(JSON.stringify(context.dump(result.error)));return context.dump(result.value)}finally{result.dispose()}};
    const actual=evaluate('JSON.stringify(('+data.source+'))');
    const recovery=evaluate('6*7');
    context.dispose();context=runtime.newContext();
    const fresh=evaluate('6*7');
    context.dispose();context=undefined;runtime.dispose();runtime=undefined;
    self.postMessage({actual,recovery,fresh,wasmSHA256:digest,metadata});
  }catch(error){self.postMessage({error:String(error)})}
  finally{context?.dispose();runtime?.dispose()}
};`
let server:Server,url:string
test.beforeAll(async()=>{
  server=createServer((req,res)=>{
    const path=new URL(req.url!,'http://localhost').pathname
    try{
      if(path==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Generator resume probe</title>');return}
      if(path==='/probe.worker.js'){res.setHeader('Content-Type','text/javascript');res.end(workerSource);return}
      if(path==='/ffi.mjs'){res.setHeader('Content-Type','text/javascript');res.end(readFileSync('node_modules/@jitl/quickjs-wasmfile-release-sync/dist/ffi.mjs'));return}
      if(!['/build.json','/core.mjs','/engine.mjs','/engine.wasm'].includes(path))throw Error('Unknown asset')
      res.setHeader('Content-Type',path.endsWith('.wasm')?'application/wasm':path.endsWith('.json')?'application/json':'text/javascript')
      res.end(readFileSync(resolve(engine,path.slice(1))))
    }catch{res.writeHead(404);res.end()}
  })
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
  url=`http://127.0.0.1:${(server.address() as {port:number}).port}/`
})
test.afterAll(async()=>{await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()))})

for(const item of cases)test(item.name,async({page},info)=>{
  const metadata=JSON.parse(readFileSync(resolve(engine,'build.json'),'utf8'))
  expect(metadata.generatorResume?.scope).toBe('direct intrinsic generator calls')
  expect(metadata.generatorResume.stageSHA256).toBe(createHash('sha256').update(readFileSync('scripts/stage-generator-resume.mjs')).digest('hex'))
  const wasmSHA256=createHash('sha256').update(readFileSync(resolve(engine,'engine.wasm'))).digest('hex')
  expect(wasmSHA256).toBe(metadata.wasmSha256)
  const oracle=spawnSync(process.execPath,['--input-type=module','-e','console.log(JSON.stringify(('+item.source+')))'],{encoding:'utf8',timeout:5000,maxBuffer:4*1024*1024})
  expect(oracle.status,oracle.stderr).toBe(0)
  expect(oracle.error).toBeUndefined()
  await page.goto(url)
  const actual=await page.evaluate(({source,wasmSHA256})=>new Promise<any>((done,reject)=>{
    const worker=new Worker('/probe.worker.js',{type:'module'})
    const timer=setTimeout(()=>{worker.terminate();reject(Error('Generator worker exceeded 15 seconds'))},15000)
    worker.onmessage=event=>{clearTimeout(timer);worker.terminate();done(event.data)}
    worker.onerror=event=>{clearTimeout(timer);worker.terminate();reject(Error(event.message))}
    worker.postMessage({source,wasmSHA256})
  }),{source:item.source,wasmSHA256})
  await info.attach('generator-resume.json',{body:JSON.stringify({name:item.name,node:process.version,expected:oracle.stdout.trim(),actual}),contentType:'application/json'})
  expect(actual.error).toBeUndefined()
  expect(actual.actual).toBe(oracle.stdout.trim())
  expect(actual.recovery).toBe(42)
  expect(actual.fresh).toBe(42)
  expect(actual.wasmSHA256).toBe(wasmSHA256)
})
