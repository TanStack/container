import {readFileSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {memoryCases,runSharedWasmMemory} from './shared-wasm-memory-harness.mjs'
const root=resolve('public/quickjs-als-asyncify-wasm-atomics-fibers-shared-storage')
const shared=readFileSync('fixtures/shared-wasm/memory.wasm'),plain=readFileSync('fixtures/shared-wasm/memory-unshared.wasm')
const expected=memoryCases(WebAssembly,shared,plain)
const core=await import(pathToFileURL(join(root,'core.mjs')).href)
const {default:factory}=await import(pathToFileURL(join(root,'engine.mjs')).href)
const {QuickJSAsyncFFI}=await import(pathToFileURL(join(root,'ffi.mjs')).href)
const engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>QuickJSAsyncFFI,importModuleLoader:async()=>()=>factory({wasmBinary:readFileSync(join(root,'engine.wasm'))})})
const native=await runSharedWasmMemory(engine,shared,plain,readFileSync('src/sandbox/guest-wasm.js','utf8'))
for(const key of Object.keys(expected))if(native[key]!==expected[key])throw Error('Native differential mismatch: '+key)
console.log(JSON.stringify({expected,native}))
if(process.argv.includes('--browser')){
  const {createServer}=await import('node:http'),{chromium,firefox,webkit}=await import('playwright')
  const files={'/harness.mjs':'scripts/shared-wasm-memory-harness.mjs','/shared.wasm':'fixtures/shared-wasm/memory.wasm','/plain.wasm':'fixtures/shared-wasm/memory-unshared.wasm','/bootstrap.js':'src/sandbox/guest-wasm.js'}
  const server=createServer((req,res)=>{
    if(req.url==='/'){
      res.setHeader('content-type','text/html')
      res.end(`<script type="module">import * as core from '/core.mjs';import factory from '/engine.mjs';import {QuickJSAsyncFFI} from '/ffi.mjs';import {runSharedWasmMemory} from '/harness.mjs';try{const bytes=await(await fetch('/engine.wasm')).arrayBuffer();const engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>QuickJSAsyncFFI,importModuleLoader:async()=>()=>factory({wasmBinary:bytes})});window.result=await runSharedWasmMemory(engine,new Uint8Array(await(await fetch('/shared.wasm')).arrayBuffer()),new Uint8Array(await(await fetch('/plain.wasm')).arrayBuffer()),await(await fetch('/bootstrap.js')).text())}catch(error){window.failure=String(error)}</script>`)
    }else if(files[req.url]||['/engine.mjs','/engine.wasm','/core.mjs','/ffi.mjs'].includes(req.url)){
      res.setHeader('content-type',req.url.endsWith('.wasm')?'application/wasm':'text/javascript')
      res.end(readFileSync(files[req.url]??join(root,req.url.slice(1))))
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
        console.log(name+': shared WASM memory ownership and growth passed')
      }finally{await browser.close()}
    }
  }finally{
    writeFileSync('reports/shared-wasm-memory.json',JSON.stringify({scope:'Shared WASM memory creation, imported ordinary loads/stores, JS/WASM growth, surviving SAB aliases and host-owned cross-runtime Memory leases. No WASM atomic instructions.',expected,native,results},null,2)+'\n')
    await new Promise(resolve=>server.close(resolve))
  }
}
