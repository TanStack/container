import {readFileSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {runSIMDFixtures} from './wasm-simd-harness.mjs'
import {runInNewContext} from 'node:vm'
import {guestWasmCases} from '../fixtures/guest-wasm-cases.mjs'
import {simdFixtures} from './wasm-simd-fixtures.mjs'
import {createHash} from 'node:crypto'

const root=resolve('public/quickjs-als-asyncify-wasm-atomics-fibers-shared-storage-simd')
const metadata=JSON.parse(readFileSync(join(root,'build.json'),'utf8'))
if(!metadata.guestWasm?.simd)throw Error('Expected SIMD candidate metadata')
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const engineBytes=readFileSync(join(root,'engine.wasm'))
if(hash(engineBytes)!==metadata.wasmSha256)throw Error('SIMD engine differs from its metadata')
const core=await import(pathToFileURL(join(root,'core.mjs')).href)
const {default:factory}=await import(pathToFileURL(join(root,'engine.mjs')).href)
const {QuickJSAsyncFFI}=await import(pathToFileURL(join(root,'ffi.mjs')).href)
const engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>QuickJSAsyncFFI,importModuleLoader:async()=>()=>factory({wasmBinary:engineBytes})})
const fixtureNames=simdFixtures.map(fixture=>fixture.name)
const fixtures=Object.fromEntries(fixtureNames.map(name=>[name,readFileSync(`fixtures/wasm-simd/${name}.wasm`)]))
const fixtureEvidence=simdFixtures.map(({name,run,expected})=>({name,wasmSHA256:hash(fixtures[name]),watSHA256:hash(readFileSync(`fixtures/wasm-simd/${name}.wat`)),runnerSHA256:hash(run.toString()),expectedSHA256:hash(JSON.stringify(expected))}))
const scalarNames=['reused module keeps callback, memory and table bindings isolated','table indirect callback reentry restores caller locals','memory identity and external grow','export descriptions','actual Webpack MD4']
const control=readFileSync('public/wasm-interpreter-probe/controls.wasm'),md4=readFileSync('public/wasm-interpreter-probe/webpack-md4.wasm')
fixtures.scalar=scalarNames.map(name=>{
  const fixture=guestWasmCases.find(item=>item.name===name)
  if(!fixture)throw Error('Missing scalar regression: '+name)
  const expected=JSON.parse(runInNewContext(fixture.code,{WebAssembly,control,md4},{timeout:5000}))
  return {name,expected,code:`const control=new Uint8Array(${JSON.stringify([...control])}),md4=new Uint8Array(${JSON.stringify([...md4])});${fixture.code}`}
})
const bootstrap=readFileSync('src/sandbox/guest-wasm.js','utf8')
const native=runSIMDFixtures(engine,fixtures,bootstrap)
console.log(JSON.stringify({host:'node',passed:native.length}))
const results=[]
if(process.argv.includes('--browser')){
  const {createServer}=await import('node:http')
  const {chromium,firefox,webkit}=await import('playwright')
  const files=Object.fromEntries(['engine.mjs','engine.wasm','core.mjs','ffi.mjs'].map(name=>['/'+name,join(root,name)]))
  for(const name of ['wasm-simd-harness','wasm-simd-fixtures','wasm-simd-cases','wasm-simd-value-cases','wasm-simd-byte-cases','wasm-simd-comparison-cases','wasm-simd-reduction-cases','wasm-simd-integer-cases','wasm-simd-lane-cases','wasm-simd-memory-cases','wasm-simd-widen-cases'])files['/'+name+'.mjs']='scripts/'+name+'.mjs'
  for(const name of fixtureNames)files['/'+name+'.wasm']='fixtures/wasm-simd/'+name+'.wasm'
  files['/bootstrap.js']='src/sandbox/guest-wasm.js'
  const server=createServer((req,res)=>{
    if(req.url==='/scalar.json'){res.setHeader('content-type','application/json');res.end(JSON.stringify(fixtures.scalar));return}
    if(req.url==='/'){
      res.setHeader('content-type','text/html')
      res.end(`<script type="module">
import * as core from '/core.mjs';
import factory from '/engine.mjs';
import {QuickJSAsyncFFI} from '/ffi.mjs';
import {runSIMDFixtures} from '/wasm-simd-harness.mjs';
try {
  const wasmBinary=await(await fetch('/engine.wasm')).arrayBuffer();
  const engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>QuickJSAsyncFFI,importModuleLoader:async()=>()=>factory({wasmBinary})});
  const fixtures={};
  for(const name of ${JSON.stringify(fixtureNames)})fixtures[name]=new Uint8Array(await(await fetch('/'+name+'.wasm')).arrayBuffer());
  fixtures.scalar=await(await fetch('/scalar.json')).json();
  window.result=runSIMDFixtures(engine,fixtures,await(await fetch('/bootstrap.js')).text());
}catch(error){window.failure=String(error)}
</script>`)
    }else if(Object.hasOwn(files,req.url)){
      res.setHeader('content-type',req.url.endsWith('.wasm')?'application/wasm':'text/javascript')
      res.end(readFileSync(files[req.url]))
    }else{res.statusCode=404;res.end()}
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  try{
    for(const [name,type] of Object.entries({chromium,firefox,webkit})){
      const browser=await type.launch()
      try{
        const page=await browser.newPage()
        await page.goto(`http://127.0.0.1:${server.address().port}/`)
        await page.waitForFunction(()=>window.result||window.failure,null,{timeout:15000})
        const state=await page.evaluate(()=>({rows:window.result,error:window.failure}))
        results.push({name,...state})
        console.log(JSON.stringify({name,passed:state.rows?.length,error:state.error}))
        if(state.error||JSON.stringify(state.rows)!==JSON.stringify(native))throw Error('SIMD comparison failed in '+name)
      }finally{await browser.close()}
    }
  }finally{await new Promise(resolve=>server.close(resolve))}
}
writeFileSync('reports/wasm-simd.json',JSON.stringify({scope:'Initial SIMD fixture subset, not full SIMD or Rolldown support',metadata,fixtureEvidence,native,results},null,2)+'\n')
