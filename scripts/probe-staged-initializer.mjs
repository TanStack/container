import {readFileSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {createServer} from 'node:http'
import {chromium,firefox,webkit} from 'playwright'

const root=resolve('public/quickjs-als-asyncify-wasm-atomics-fibers-shared-storage-simd-lazy-wasm-initializer-probe')
const source=readFileSync('public/vm-web-apis/globals.js')
const build=JSON.parse(readFileSync(join(root,'build.json'),'utf8'))
if(!build.initializerProbe)throw Error('Expected dedicated initializer probe build')
const probeSHA256=createHash('sha256').update(readFileSync('fixtures/compiled-initializer-probe.c')).digest('hex')
if(build.initializerProbe.bindingSHA256!==probeSHA256)throw Error('Stale initializer probe build, rebuild before testing')
const expected=JSON.stringify({request:'Request',response:'Response'})
const results=[]
const execute=async(factory,bytes,source)=>{
 const stdout=[],stderr=[]
 const raw=await factory({wasmBinary:bytes,print:line=>stdout.push(line),printErr:line=>stderr.push(line)})
 const pointer=raw._malloc(source.length)
 if(!pointer)throw Error('Source allocation failed')
 let status
 try{raw.HEAPU8.set(source,pointer);status=raw._QTS_ProbeCompiledInitializer(pointer,source.length)}finally{raw._free(pointer)}
 return {status,stdout,stderr}
}
const {default:factory}=await import(pathToFileURL(join(root,'engine.mjs')).href)
const native=await execute(factory,readFileSync(join(root,'engine.wasm')),source)
results.push({name:'node',...native})
const server=createServer((req,res)=>{
 if(req.url==='/'){
  res.setHeader('content-type','text/html');res.end(`<script type="module">
import factory from '/engine.mjs';const execute=${execute.toString()};
try{window.result=await execute(factory,await(await fetch('/engine.wasm')).arrayBuffer(),new Uint8Array(await(await fetch('/source')).arrayBuffer()))}catch(error){window.failure=String(error)}
</script>`);return
 }
 if(req.url==='/source'){res.end(source);return}
 if(['/engine.mjs','/engine.wasm'].includes(req.url)){
  res.setHeader('content-type',req.url.endsWith('.wasm')?'application/wasm':'text/javascript');res.end(readFileSync(join(root,req.url.slice(1))));return
 }
 res.statusCode=404;res.end()
})
await new Promise(done=>server.listen(0,'127.0.0.1',done))
try{
 for(const [name,type] of Object.entries({chromium,firefox,webkit})){
  const browser=await type.launch()
  try{
   const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/`)
   await page.waitForFunction(()=>window.result||window.failure,null,{timeout:30000})
   const observed=await page.evaluate(()=>({result:window.result,error:window.failure}))
   results.push({name,...observed.result,error:observed.error})
  }finally{await browser.close()}
 }
}finally{
 await new Promise(done=>server.close(done))
 for(const row of results)row.passed=!row.error&&row.status===0&&row.stdout.length===4&&row.stdout.every(line=>line===expected)
 const report={scope:'Fully staged engine with candidate-only probe export, not WorkerKernel integration.',build,sourceSHA256:createHash('sha256').update(source).digest('hex'),results}
 writeFileSync('reports/staged-initializer.json',JSON.stringify(report,null,2)+'\n')
 console.log(JSON.stringify(results,null,2));if(results.some(row=>!row.passed))process.exitCode=1
}
