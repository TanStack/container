import ASYNCIFY from '@jitl/quickjs-wasmfile-release-asyncify'
import type {QuickJSAsyncWASMModule} from 'quickjs-emscripten-core'
import {abortableWait} from './abortable-wait'
import {SharedAsset} from './shared-asset'
import {CooperativeYield} from './cooperative-yield'
import {runtimeAssetURL} from './runtime-assets'

// Compiled code is immutable. Instances, memories and Asyncify stacks remain
// process-owned. Keep failed loads retryable instead of caching a rejection.
const compiledModules=new SharedAsset<WebAssembly.Module>(async(url,signal)=>{
  const response=await fetch(url,{signal})
  if(!response.ok)throw Error('Engine fetch failed: '+response.status)
  const bytes=await response.arrayBuffer()
  signal.throwIfAborted()
  return WebAssembly.compile(bytes)
})

// One Asyncify module per process. Do not share its suspended native stack.
export async function createCooperativeEngine(guestWasm:boolean,signal:AbortSignal,assetBaseURL?:string){
  signal.throwIfAborted()
  const base=runtimeAssetURL('quickjs-als-asyncify'+(guestWasm?'-wasm':'')+'-cooperative/',assetBaseURL)
  const load=(file:string)=>import(/* @vite-ignore */new URL(file,base).href)
  const [core,loader,ffi,compiled]=await abortableWait(Promise.all([load('core.mjs'),load('engine.mjs'),load('ffi.mjs'),compiledModules.acquire(new URL('engine.wasm',base).href,signal)]),signal)
  signal.throwIfAborted()
  let raw:{cooperativeScheduling?:boolean;cooperativeMetrics?:{yields:number;waitMs:number;maxWaitMs:number}}|undefined
  const yielding=new CooperativeYield()
  const engine:QuickJSAsyncWASMModule=await abortableWait(core.newQuickJSAsyncWASMModuleFromVariant(core.newVariant({
    ...ASYNCIFY,importFFI:async()=>ffi.QuickJSAsyncFFI,
    importModuleLoader:async()=>async(options:object)=>{
      const module=await loader.default(options)
      module.scheduleCooperativeYield=(resume:()=>void)=>yielding.schedule(resume)
      module.cooperativeScheduling=false;raw=module;return module
    },
  },{wasmModule:compiled})),signal)
  signal.throwIfAborted()
  return {
    engine,
    close(){yielding.close()},
    schedulingMetrics(){return raw?.cooperativeMetrics?{...raw.cooperativeMetrics}:undefined},
    async run<T>(operation:()=>Promise<T>):Promise<T>{
      raw!.cooperativeScheduling=true
      try{return await operation()}finally{raw!.cooperativeScheduling=false}
    },
    synchronous<T>(operation:()=>T):T{
      const previous=raw!.cooperativeScheduling;raw!.cooperativeScheduling=false
      try{return operation()}finally{raw!.cooperativeScheduling=previous}
    },
  }
}
