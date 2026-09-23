import {createServer} from 'node:http'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {webkit} from '@playwright/test'

const engine=resolve(process.argv[2]??'public/quickjs-als-asyncify-wasm-o2-atomics-fibers-shared-storage-simd-lazy-wasm-compiled-initializers-iterative-calls-module-import-exports')
const source=readFileSync('fixtures/start-vite8-wasm/node_modules/@babel/types/lib/builders/generated/uppercase.js','utf8')
async function worker(){
  self.onmessage=async({data})=>{
    const core=await import('/core.mjs'),factory=(await import('/engine.mjs')).default,{QuickJSAsyncFFI}=await import('/ffi.mjs')
    const engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>QuickJSAsyncFFI,importModuleLoader:async()=>async()=>factory({wasmBinary:await(await fetch('/engine.wasm')).arrayBuffer()})})
    const results=[]
    for(const mode of ['direct','pending-job'])for(const depth of [0,4]){
      const runtime=engine.newRuntime(),context=runtime.newContext()
      runtime.setMemoryLimit(64*1024*1024);runtime.setMaxStackSize(256*1024)
      const deadline=performance.now()+10000;runtime.setInterruptHandler(()=>performance.now()>deadline)
      const hostErrors=[]
      const compile=context.newFunction('compile',()=>{
        try{return context.evalCode('(function(exports,require,module,__filename,__dirname){\n'+data.source+'\n})','uppercase.js')}
        catch(error){hostErrors.push({message:error.message,stack:error.stack});throw error}
      })
      context.setProp(context.global,'compile',compile);compile.dispose()
      const initializer=context.unwrapResult(context.evalCode('park=>{}'));context.unwrapResult(context.initializeFiber(initializer)).dispose();initializer.dispose()
      const code='function nest(n){if(n)return nest.call(null,n-1);return typeof compile()};'
      let pump
      if(mode==='pending-job'){
        context.unwrapResult(context.evalCode(code+'Promise.resolve().then(()=>{globalThis.probeValue=nest('+depth+')})')).dispose()
        pump=context.unwrapResult(context.evalCode('()=>__qjsExecutePendingJobs(100)'))
      }
      const task=pump?context.startFiberCall(pump):context.startFiberEval(code+'nest('+depth+')','probe.js',0)
      const status=task.step();if(status!==2)throw Error('Unexpected fiber status '+status)
      const result=task.takeResult()
      try{results.push({mode,depth,value:result.error?undefined:context.dump(result.value),error:result.error?context.dump(result.error):undefined,hostErrors})}finally{result.dispose()}
      if(mode==='pending-job'){const value=context.getProp(context.global,'probeValue');results.at(-1).compiled=context.dump(value);value.dispose()}
      const recovery=context.evalCode('6*7');results.at(-1).recovery=context.dump(recovery.error??recovery.value);recovery.dispose()
      task.dispose();pump?.dispose();context.dispose();runtime.dispose()
    }
    self.postMessage(results)
  }
}
const server=createServer((req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname
  if(path==='/'){res.end('<!doctype html>');return}
  if(path==='/worker.mjs'){res.setHeader('Content-Type','text/javascript');res.end('('+worker.toString()+')()');return}
  if(!['/core.mjs','/engine.mjs','/ffi.mjs','/engine.wasm'].includes(path)){res.writeHead(404);res.end();return}
  res.setHeader('Content-Type',path.endsWith('.wasm')?'application/wasm':'text/javascript');res.end(readFileSync(resolve(engine,path.slice(1))))
})
await new Promise(done=>server.listen(0,'127.0.0.1',done))
const browser=await webkit.launch()
try{
  const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port)
  const results=await page.evaluate(source=>new Promise((done,reject)=>{
    const worker=new Worker('/worker.mjs',{type:'module'}),timer=setTimeout(()=>{worker.terminate();reject(Error('Probe timeout'))},30000)
    worker.onmessage=event=>{clearTimeout(timer);worker.terminate();done(event.data)}
    worker.onerror=event=>{clearTimeout(timer);worker.terminate();reject(Error(event.message))}
    worker.postMessage({source})
  }),source)
  console.log(JSON.stringify({engine,results},null,2))
}finally{await browser.close();await new Promise(done=>server.close(done))}
