import {newVariant} from 'quickjs-emscripten-core'
import SYNC from '@jitl/quickjs-wasmfile-release-sync'

export async function probeNativeAtomics(source:string){
  const path='/quickjs-als-atomics'
  const wrapper=await import(/* @vite-ignore */new URL(path+'/core.mjs',location.href).href)
  const engine=await wrapper.newQuickJSWASMModuleFromVariant(newVariant({
    ...SYNC,importModuleLoader:async()=>{
      const url=new URL(path+'/engine.mjs',location.href).href
      return (await import(/* @vite-ignore */url)).default
    },
  },{wasmLocation:new URL(path+'/engine.wasm',location.href).href}))
  const runtime=engine.newRuntime(),context=runtime.newContext()
  runtime.setMemoryLimit(16*1024*1024)
  const deadline=performance.now()+5000
  runtime.setInterruptHandler(()=>performance.now()>deadline)
  try{
    const result=context.evalCode(source)
    if(result.error){try{throw Error(JSON.stringify(context.dump(result.error)))}finally{result.error.dispose()}}
    try{return {value:context.dump(result.value),crossOriginIsolated,hostSharedArrayBuffer:typeof SharedArrayBuffer}}finally{result.value.dispose()}
  }finally{context.dispose();runtime.dispose()}
}
