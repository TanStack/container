import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {build} from 'esbuild'
const root=resolve('public/quickjs-als-asyncify-fibers')
const directory=mkdtempSync(join(tmpdir(),'fiber-wrapper-'))
await build({entryPoints:['scripts/fiber-wrapper-harness.mjs'],outfile:join(directory,'harness.mjs'),bundle:true,platform:'browser',format:'esm'})
const core=await import(pathToFileURL(join(root,'core.mjs')).href)
const {default:factory}=await import(pathToFileURL(join(root,'engine.mjs')).href)
const {QuickJSAsyncFFI}=await import(pathToFileURL(join(root,'ffi.mjs')).href)
const {runFiberWrapper}=await import(pathToFileURL(join(directory,'harness.mjs')).href)
const engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>QuickJSAsyncFFI,importModuleLoader:async()=>()=>factory({wasmBinary:readFileSync(join(root,'engine.wasm'))})})
const native=await runFiberWrapper(engine)
console.log(JSON.stringify({native}))
if(process.argv.includes('--browser')){
  const {createServer}=await import('node:http')
  const {chromium,firefox,webkit}=await import('playwright')
  const server=createServer((req,res)=>{
    if(req.url==='/'){
      res.setHeader('content-type','text/html')
      res.end(`<script type="module">import * as core from '/core.mjs';import factory from '/engine.mjs';import {QuickJSAsyncFFI} from '/ffi.mjs';import {runFiberWrapper} from '/harness.mjs';try{const bytes=await(await fetch('/engine.wasm')).arrayBuffer();const engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>QuickJSAsyncFFI,importModuleLoader:async()=>()=>factory({wasmBinary:bytes})});window.result=await runFiberWrapper(engine)}catch(error){window.failure=String(error)}</script>`)
    }else if(['/engine.mjs','/engine.wasm','/core.mjs','/ffi.mjs','/harness.mjs'].includes(req.url)){
      res.setHeader('content-type',req.url.endsWith('.wasm')?'application/wasm':'text/javascript')
      res.end(readFileSync(join(req.url==='/harness.mjs'?directory:root,req.url.slice(1))))
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
        console.log(name+': normal wrapper fiber call passed')
      }finally{await browser.close()}
    }
  }finally{
    writeFileSync('reports/fiber-wrapper.json',JSON.stringify({scope:'Experimental normal QuickJS wrapper fiber calls and module loader, not WorkerKernel integration.',native,results},null,2)+'\n')
    await new Promise(resolve=>server.close(resolve))
  }
}
