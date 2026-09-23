import type {QuickJSContext,QuickJSHandle} from 'quickjs-emscripten-core'
import {TrustedInitializerCache} from './trusted-initializer-cache'

type InitializerContext=QuickJSContext&{
  compileTrustedInitializer?(source:QuickJSHandle):ReturnType<QuickJSContext['evalCode']>
  evalTrustedInitializer?(bytes:QuickJSHandle):ReturnType<QuickJSContext['evalCode']>
}
// The fixed fiber engines live for the kernel worker's lifetime. Weak keys keep
// this cache from extending an engine's lifetime; terminating the worker drops
// all entries. Each entry retains at most 8 MiB plus the fixed source string.
const caches=new WeakMap<object,TrustedInitializerCache>()

export function initializeTrustedWebAPIs(engine:object,context:InitializerContext,source:string){
  if(!context.compileTrustedInitializer||!context.evalTrustedInitializer){
    context.unwrapResult(context.evalCode(source,'web-apis.js')).dispose()
    return {compiled:false,retainedBytes:0}
  }
  let cache=caches.get(engine)
  if(!cache){cache=new TrustedInitializerCache(engine);caches.set(engine,cache)}
  cache.use(engine,source,()=>{
    const input=context.newString(source)
    try{
      const compiled=context.unwrapResult(context.compileTrustedInitializer!(input))
      try{
        const view=context.getArrayBuffer(compiled)
        try{return view.value.slice()}finally{view.dispose()}
      }finally{compiled.dispose()}
    }finally{input.dispose()}
  },bytes=>{
    // This temporary host copy and the context-owned ArrayBuffer are released
    // after evaluation. The context allocation uses its existing heap limit.
    const input=context.newArrayBuffer(bytes.buffer as ArrayBuffer)
    try{context.unwrapResult(context.evalTrustedInitializer!(input)).dispose()}finally{input.dispose()}
  })
  return {compiled:true,retainedBytes:cache.retainedBytes}
}
