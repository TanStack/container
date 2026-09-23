import {readFileSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {atomicCases} from './wasm-atomics-cases.mjs'
import {runWasmAtomics} from './wasm-atomics-harness.mjs'

const root=resolve('public/quickjs-als-asyncify-wasm-atomics-fibers-shared-storage')
const shared=readFileSync('fixtures/shared-wasm/atomic-coverage.wasm'),plain=readFileSync('fixtures/shared-wasm/atomic-coverage-unshared.wasm')
const expected=atomicCases(WebAssembly,shared,plain)
const core=await import(pathToFileURL(join(root,'core.mjs')).href)
const {default:factory}=await import(pathToFileURL(join(root,'engine.mjs')).href)
const {QuickJSAsyncFFI}=await import(pathToFileURL(join(root,'ffi.mjs')).href)
const engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>QuickJSAsyncFFI,importModuleLoader:async()=>()=>factory({wasmBinary:readFileSync(join(root,'engine.wasm'))})})
const native=await runWasmAtomics(engine,shared,plain,readFileSync('src/sandbox/guest-wasm.js','utf8'))
const mismatches=expected.filter((entry,index)=>JSON.stringify(entry)!==JSON.stringify(native.cases[index])).map(entry=>({expected:entry,actual:native.cases.find(item=>item[0]===entry[0])}))
if(mismatches.length||native.cases.length!==expected.length)throw Error(JSON.stringify({mismatches,expected:expected.length,actual:native.cases.length}))
console.log(`Node-hosted candidate: ${expected.length} native atomic results matched, ${native.interop.length} wait/notify combinations passed`)
const results=[]
if(process.argv.includes('--browser')){
  const {createServer}=await import('node:http'),{chromium,firefox,webkit}=await import('playwright')
  const files={'/harness.mjs':'scripts/wasm-atomics-harness.mjs','/wasm-atomics-cases.mjs':'scripts/wasm-atomics-cases.mjs','/shared.wasm':'fixtures/shared-wasm/atomic-coverage.wasm','/plain.wasm':'fixtures/shared-wasm/atomic-coverage-unshared.wasm','/bootstrap.js':'src/sandbox/guest-wasm.js'}
  const server=createServer((req,res)=>{
    if(req.url==='/'){
      res.setHeader('content-type','text/html')
      res.end(`<script type="module">import * as core from '/core.mjs';import factory from '/engine.mjs';import {QuickJSAsyncFFI} from '/ffi.mjs';import {runWasmAtomics} from '/harness.mjs';try{const bytes=await(await fetch('/engine.wasm')).arrayBuffer();const engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>QuickJSAsyncFFI,importModuleLoader:async()=>()=>factory({wasmBinary:bytes})});window.result=await runWasmAtomics(engine,new Uint8Array(await(await fetch('/shared.wasm')).arrayBuffer()),new Uint8Array(await(await fetch('/plain.wasm')).arrayBuffer()),await(await fetch('/bootstrap.js')).text())}catch(error){window.failure=String(error)}</script>`)
    }else if(files[req.url]||['/engine.mjs','/engine.wasm','/core.mjs','/ffi.mjs'].includes(req.url)){
      res.setHeader('content-type',req.url.endsWith('.wasm')?'application/wasm':'text/javascript')
      res.end(readFileSync(files[req.url]??join(root,req.url.slice(1))))
    }else{res.statusCode=404;res.end()}
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  try{
    for(const [name,type] of Object.entries({chromium,firefox,webkit})){
      const browser=await type.launch()
      try{
        const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message))
        await page.goto(`http://127.0.0.1:${server.address().port}/`)
        await page.waitForFunction(()=>window.result||window.failure,null,{timeout:20000})
        const state=await page.evaluate(()=>({result:window.result,failure:window.failure,isolated:crossOriginIsolated}))
        results.push({name,...state,errors})
        if(state.failure||errors.length||JSON.stringify(state.result)!==JSON.stringify(native))throw Error(JSON.stringify(results.at(-1)))
        console.log(name+': atomic instructions and fiber interoperability passed')
      }finally{await browser.close()}
    }
  }finally{await new Promise(resolve=>server.close(resolve))}
}
writeFileSync('reports/wasm-atomics.json',JSON.stringify({scope:'Standard integer WASM atomics in a single-engine fiber scheduler, native differential cases and JS/WASM wait-notify interoperability. Not concurrent host pthread execution.',engine:JSON.parse(readFileSync(join(root,'build.json'),'utf8')),expected,native,results},null,2)+'\n')
