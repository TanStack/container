import {newQuickJSWASMModuleFromVariant,newVariant} from 'quickjs-emscripten-core'
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync'
import {probeContextGlobals} from '../../fixtures/context-global-cases.mjs'
import {probeContextPrimitives} from '../../fixtures/context-primitives.mjs'
import bootstrap from '../../src/sandbox/engine-als-bootstrap.js?raw'

self.onmessage=async({data:{reference,primitives}})=>{
  try{
    // Deliberately separate from the verified engine served by the lab.
    const base='/quickjs-als-oz/'
    const loader=(await import(/* @vite-ignore */ new URL(base+'engine.mjs',self.location.href).href)).default
    const build=await (await fetch(base+'build.json')).json()
    const engine=await newQuickJSWASMModuleFromVariant(newVariant({...RELEASE_SYNC,importModuleLoader:async()=>loader},{wasmLocation:new URL(base+'engine.wasm',self.location.href).href}))
    const rounds=[]
    for(let index=0;index<3;index++)rounds.push({globals:probeContextGlobals(engine,reference),primitives:probeContextPrimitives(engine,bootstrap,primitives)})
    self.postMessage({rounds,build,crossOriginIsolated:self.crossOriginIsolated,wasmHeapBytes:engine.getWasmMemory().buffer.byteLength})
  }catch(error){self.postMessage({error:String(error)+'\n'+error?.stack})}
}
