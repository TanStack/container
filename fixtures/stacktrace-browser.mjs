import {newQuickJSWASMModuleFromVariant,newVariant} from 'quickjs-emscripten-core'
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync'

export async function probeStacktrace(directory,source){
  if(!['quickjs-als','quickjs-als-wasm'].includes(directory))throw Error('Unknown engine')
  const loader=(await import(/* @vite-ignore */'/'+directory+'/engine.mjs')).default
  const bytes=await fetch('/'+directory+'/engine.wasm').then(r=>r.arrayBuffer())
  const engine=await newQuickJSWASMModuleFromVariant(newVariant({...RELEASE_SYNC,importModuleLoader:async()=>loader},{wasmBinary:bytes}))
  const runtime=engine.newRuntime();runtime.setMemoryLimit(16*1024*1024);const deadline=performance.now()+2000;runtime.setInterruptHandler(()=>performance.now()>deadline)
  const ctx=runtime.newContext()
  try{const result=ctx.evalCode(source,'stack-capture.js');try{return result.error?{error:ctx.dump(result.error)}:ctx.dump(result.value)}finally{(result.error??result.value).dispose()}}
  finally{ctx.dispose();runtime.dispose()}
}
