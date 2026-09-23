import {readFileSync,existsSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'

const root=resolve(process.argv[2]??'public/quickjs-als-asyncify-wasm-o2-atomics-fibers-shared-storage-simd-lazy-wasm-compiled-initializers-iterative-calls')
const core=await import(pathToFileURL(join(root,'core.mjs')).href)
const {default:factory}=await import(pathToFileURL(join(root,'engine.mjs')).href)
let engine
if(process.argv.includes('--upstream')){
  const {newQuickJSWASMModuleFromVariant}=await import('quickjs-emscripten-core')
  const {default:SYNC}=await import('@jitl/quickjs-wasmfile-release-sync')
  engine=await newQuickJSWASMModuleFromVariant(SYNC)
}else if(existsSync(join(root,'ffi.mjs'))){
  const {QuickJSAsyncFFI}=await import(pathToFileURL(join(root,'ffi.mjs')).href)
  engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>QuickJSAsyncFFI,importModuleLoader:async()=>async()=>factory({wasmBinary:readFileSync(join(root,'engine.wasm'))})})
}else{
  const {default:SYNC}=await import('@jitl/quickjs-wasmfile-release-sync')
  engine=await core.newQuickJSWASMModuleFromVariant({...SYNC,importModuleLoader:async()=>async()=>factory({wasmBinary:readFileSync(join(root,'engine.wasm'))})})
}
const runtime=engine.newRuntime(),context=runtime.newContext()
runtime.setMemoryLimit(32*1024*1024);runtime.setMaxStackSize(256*1024)
const modules={
  server:`import {load} from 'load';export {load};`,
  load:`import {Router} from 'router';export async function load(){return 42}`,
  router:`import {load} from 'server';export class Router{constructor(){this.load=async()=>load()}}`,
}
runtime.setModuleLoader(id=>modules[id],(_base,id)=>id)
try{
  const result=context.evalCode(`import * as server from 'server';import {Router} from 'router';globalThis.result={type:typeof server.load};new Router().load().then(value=>result.value=value,error=>result.error={message:error.message,stack:error.stack})`,'entry.mjs',{type:'module'})
  if(result.error)throw context.dump(result.error);result.dispose()
  while(runtime.hasPendingJob())context.unwrapResult(runtime.executePendingJobs(100))
  const answer=context.getProp(context.global,'result');console.log(JSON.stringify({root,result:context.dump(answer)}));answer.dispose()
}finally{context.dispose();runtime.dispose()}
