import {newQuickJSWASMModuleFromVariant,newVariant} from 'quickjs-emscripten-core'
import SYNC from '@jitl/quickjs-wasmfile-release-sync'
import {probeAllocatorAccounting,probeContextAllocation} from '../../fixtures/allocator-accounting.mjs'

self.onmessage=async()=>{
  try{
    const base='/quickjs-als/'
    const loader=(await import(/* @vite-ignore */ new URL(base+'engine.mjs',self.location.href).href)).default
    const engine=await newQuickJSWASMModuleFromVariant(newVariant({...SYNC,importModuleLoader:async()=>loader},{wasmLocation:new URL(base+'engine.wasm',self.location.href).href}))
    const build=await (await fetch(base+'build.json')).json()
    self.postMessage({build,accounting:probeAllocatorAccounting(engine),allocation:probeContextAllocation(engine)})
  }catch(error){self.postMessage({error:String(error)+'\n'+error?.stack})}
}
