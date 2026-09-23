import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'

// Compile the unchanged package module through the normal guest API. No
// instantiation, imported callbacks or compiler-sized linear memory is needed.
const root=resolve('public/quickjs-als-asyncify-wasm-atomics-fibers-shared-storage-simd')
const metadata=JSON.parse(readFileSync(join(root,'build.json'),'utf8'))
if(!metadata.guestWasm?.simd)throw Error('Expected SIMD candidate')
const engineBytes=readFileSync(join(root,'engine.wasm'))
const engineSHA256=createHash('sha256').update(engineBytes).digest('hex')
if(engineSHA256!==metadata.wasmSha256)throw Error('Candidate engine differs from its build metadata')
const packageRoot='fixtures/compiler-wasi/node_modules/@rolldown/binding-wasm32-wasi'
const bytes=readFileSync(join(packageRoot,'rolldown-binding.wasm32-wasi.wasm'))
const packageInfo=JSON.parse(readFileSync(join(packageRoot,'package.json'),'utf8'))
new WebAssembly.Module(bytes)
const core=await import(pathToFileURL(join(root,'core.mjs')).href)
const {default:factory}=await import(pathToFileURL(join(root,'engine.mjs')).href)
const {QuickJSAsyncFFI}=await import(pathToFileURL(join(root,'ffi.mjs')).href)
const engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>QuickJSAsyncFFI,importModuleLoader:async()=>()=>factory({wasmBinary:engineBytes})})
const runtime=engine.newRuntime()
runtime.setMemoryLimit(256*1024*1024)
runtime.setMaxStackSize(256*1024)
const startedAt=new Date().toISOString(),started=performance.now()
const deadline=Date.now()+15000
runtime.setInterruptHandler(()=>Date.now()>deadline)
const context=runtime.newContext()
let result
try{
  const buffer=context.newArrayBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength))
  try{context.setProp(context.global,'packageBytes',buffer)}finally{buffer.dispose()}
  const evaluated=context.evalCode(readFileSync('src/sandbox/guest-wasm.js','utf8')+`;new WebAssembly.Module(new Uint8Array(packageBytes));true`)
  try{result=evaluated.error?{passed:false,error:context.dump(evaluated.error)}:{passed:context.dump(evaluated.value)===true}}
  finally{evaluated.dispose()}
}finally{context.dispose();runtime.dispose()}
const report={scope:'Unchanged Rolldown WASM module construction only, not binding instantiation or bundling',startedAt,elapsedMs:performance.now()-started,node:process.version,limits:{memoryBytes:256*1024*1024,stackBytes:256*1024,timeoutMs:15000},engineSHA256,package:packageInfo.name,version:packageInfo.version,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),nativeAccepted:true,metadata,result}
mkdirSync('reports/wasm-simd-compiler-runs',{recursive:true})
const attempt='reports/wasm-simd-compiler-runs/'+startedAt.replaceAll(':','-')+'-'+engineSHA256.slice(0,12)+'.json'
writeFileSync(attempt,JSON.stringify(report,null,2)+'\n',{flag:'wx'})
writeFileSync('reports/wasm-simd-compiler.json',JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({package:report.package,version:report.version,bytes:report.bytes,result,attempt}))
if(!result.passed)process.exitCode=1
