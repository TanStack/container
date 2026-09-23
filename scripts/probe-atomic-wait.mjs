import {readFileSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {runAtomicWait} from './atomic-wait-harness.mjs'
const root=resolve('public/quickjs-als-asyncify-atomics-fibers-shared-storage')
const core=await import(pathToFileURL(join(root,'core.mjs')).href)
const {default:factory}=await import(pathToFileURL(join(root,'engine.mjs')).href)
const {QuickJSAsyncFFI}=await import(pathToFileURL(join(root,'ffi.mjs')).href)
const engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>QuickJSAsyncFFI,importModuleLoader:async()=>()=>factory({wasmBinary:readFileSync(join(root,'engine.wasm'))})})
const native=await runAtomicWait(engine)
console.log(JSON.stringify({native}))
if(process.argv.includes('--browser')){
  const {createServer}=await import('node:http')
  const {chromium,firefox,webkit}=await import('playwright')
  const server=createServer((req,res)=>{
    if(req.url==='/'){
      res.setHeader('content-type','text/html')
      res.end(`<script type="module">import * as core from '/core.mjs';import factory from '/engine.mjs';import {QuickJSAsyncFFI} from '/ffi.mjs';import {runAtomicWait} from '/harness.mjs';try{const bytes=await(await fetch('/engine.wasm')).arrayBuffer();const engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>QuickJSAsyncFFI,importModuleLoader:async()=>()=>factory({wasmBinary:bytes})});window.result=await runAtomicWait(engine)}catch(error){window.failure=String(error)}</script>`)
    }else if(['/engine.mjs','/engine.wasm','/core.mjs','/ffi.mjs','/harness.mjs'].includes(req.url)){
      res.setHeader('content-type',req.url.endsWith('.wasm')?'application/wasm':'text/javascript')
      res.end(readFileSync(req.url==='/harness.mjs'?'scripts/atomic-wait-harness.mjs':join(root,req.url.slice(1))))
    }else{res.statusCode=404;res.end()}
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const results=[]
  try{
    for(const [name,type] of Object.entries({chromium,firefox,webkit})){
      const browser=await type.launch()
      try{
        const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message))
        await page.goto(`http://127.0.0.1:${server.address().port}/`)
        await page.waitForFunction(()=>window.result||window.failure,null,{timeout:15000})
        const state=await page.evaluate(()=>({result:window.result,failure:window.failure,isolated:crossOriginIsolated}))
        results.push({name,...state,errors})
        if(state.failure||errors.length||JSON.stringify(state.result)!==JSON.stringify(native))throw Error(JSON.stringify(results.at(-1)))
        console.log(name+': native guest atomic wait/notify passed')
      }finally{await browser.close()}
    }
  }finally{
    writeFileSync('reports/atomic-wait.json',JSON.stringify({scope:'Native QuickJS Atomics.wait/notify over scheduler-owned fibers and fixed shared backing, not WASM threads.',native,results},null,2)+'\n')
    await new Promise(resolve=>server.close(resolve))
  }
}
