import {readFileSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {runFairnessCandidate} from './fiber-fairness-candidate-harness.mjs'
import {runWasmFairnessGuard} from './fiber-fairness-wasm-guard.mjs'

if(!process.env.FAIRNESS_ENGINE)throw Error('Set FAIRNESS_ENGINE to the isolated candidate engine directory')
const root=resolve(process.env.FAIRNESS_ENGINE)
const combined=Boolean(JSON.parse(readFileSync(join(root,'build.json'),'utf8')).guestWasm)
const bootstrap=combined?readFileSync('src/sandbox/guest-wasm.js','utf8'):''
const core=await import(pathToFileURL(join(root,'core.mjs')).href)
const {default:factory}=await import(pathToFileURL(join(root,'engine.mjs')).href)
const {QuickJSAsyncFFI}=await import(pathToFileURL(join(root,'ffi.mjs')).href)
const engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>QuickJSAsyncFFI,importModuleLoader:async()=>async()=>factory({wasmBinary:readFileSync(join(root,'engine.wasm'))})})
const result={scope:'Isolated JS fairness candidate, no yielding inside WASM, not packaged SDK or Start acceptance',root,native:await runFairnessCandidate(engine),...(combined?{wasmGuard:runWasmFairnessGuard(engine,bootstrap)}:{}),browsers:[]}
if(process.argv.includes('--browser')){
  const {createServer}=await import('node:http'),{chromium,firefox,webkit}=await import('playwright')
  const server=createServer((req,res)=>{
    if(req.url==='/'){res.setHeader('content-type','text/html');res.end(`<script type="module">import * as core from '/core.mjs';import factory from '/engine.mjs';import {QuickJSAsyncFFI} from '/ffi.mjs';import {runFairnessCandidate} from '/harness.mjs';import {runWasmFairnessGuard} from '/wasm-guard.mjs';try{const bytes=await(await fetch('/engine.wasm')).arrayBuffer();const engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>QuickJSAsyncFFI,importModuleLoader:async()=>async()=>factory({wasmBinary:bytes})});const result=await runFairnessCandidate(engine);if(${combined})result.wasmGuard=runWasmFairnessGuard(engine,await(await fetch('/bootstrap.txt')).text());window.result=result}catch(error){window.failure=String(error)}</script>`);return}
    if(req.url==='/wasm-guard.mjs'){res.setHeader('content-type','text/javascript');res.end(readFileSync('scripts/fiber-fairness-wasm-guard.mjs'));return}
    if(req.url==='/bootstrap.txt'){res.setHeader('content-type','text/plain');res.end(bootstrap);return}
    if(!['/core.mjs','/engine.mjs','/engine.wasm','/ffi.mjs','/harness.mjs'].includes(req.url)){res.statusCode=404;res.end();return}
    res.setHeader('content-type',req.url.endsWith('.wasm')?'application/wasm':'text/javascript')
    res.end(readFileSync(req.url==='/harness.mjs'?resolve('scripts/fiber-fairness-candidate-harness.mjs'):join(root,req.url.slice(1))))
  })
  await new Promise(done=>server.listen(0,'127.0.0.1',done))
  try{
    for(const [name,type] of Object.entries({chromium,firefox,webkit})){
      const browser=await type.launch()
      try{
        const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message))
        await page.goto(`http://127.0.0.1:${server.address().port}/`)
        await page.waitForFunction(()=>window.result||window.failure,null,{timeout:15000})
        const state=await page.evaluate(()=>({result:window.result,failure:window.failure}))
        result.browsers.push({name,...state,errors})
        if(state.failure||errors.length)throw Error(JSON.stringify(result.browsers.at(-1)))
      }finally{await browser.close()}
    }
  }finally{await new Promise(done=>server.close(done));writeFileSync(combined?'reports/fiber-fairness-combined.json':'reports/fiber-fairness-candidate.json',JSON.stringify(result,null,2)+'\n')}
}
console.log(JSON.stringify(result,null,2))
