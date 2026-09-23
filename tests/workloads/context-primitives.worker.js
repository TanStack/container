import {newQuickJSWASMModuleFromVariant,newVariant} from 'quickjs-emscripten-core'
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync'
import {probeContextPrimitives} from '../../fixtures/context-primitives.mjs'
import bootstrap from '../../src/sandbox/engine-als-bootstrap.js?raw'

self.onmessage=async({data:reference})=>{
  try{
    const url=new URL('/quickjs-als/engine.mjs',self.location.href).href
    const loader=(await import(/* @vite-ignore */ url)).default
    const engine=await newQuickJSWASMModuleFromVariant(newVariant({...RELEASE_SYNC,importModuleLoader:async()=>loader},{wasmLocation:new URL('/quickjs-als/engine.wasm',self.location.href).href}))
    const rounds=[]
    for(let index=0;index<3;index++)rounds.push(probeContextPrimitives(engine,bootstrap,reference))
    self.postMessage({rounds,crossOriginIsolated:self.crossOriginIsolated})
  }catch(error){self.postMessage({error:String(error)+'\n'+error?.stack})}
}
