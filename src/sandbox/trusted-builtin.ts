import type {QuickJSContext,QuickJSHandle} from 'quickjs-emscripten-core'
import {TrustedInitializerCache} from './trusted-initializer-cache'

type BuiltinContext=QuickJSContext&{
  compileTrustedInitializerWithFilename?(source:QuickJSHandle,filename:QuickJSHandle):ReturnType<QuickJSContext['evalCode']>
  evalTrustedInitializer?(bytes:QuickJSHandle):ReturnType<QuickJSContext['evalCode']>
}
// Each fixed shipped initializer has its own per-engine cache, bounded to
// 8 MiB of bytecode. Never cache project modules or share guest handles,
// formatter objects or process objects across contexts.
const caches=new WeakMap<object,TrustedInitializerCache>()
const inspectionCaches=new WeakMap<object,TrustedInitializerCache>()
export function compileTrustedProcessBuiltin(engine:object,context:BuiltinContext,source:string){
  return compileTrusted(engine,context,source,'node:process',caches)
}
export function compileTrustedInspectionInitializer(engine:object,context:BuiltinContext,source:string){
  return compileTrusted(engine,context,source,'inspection-initializer.js',inspectionCaches)
}
function compileTrusted(engine:object,context:BuiltinContext,source:string,name:string,caches:WeakMap<object,TrustedInitializerCache>){
  if(!context.compileTrustedInitializerWithFilename||!context.evalTrustedInitializer)return context.evalCode(source,name)
  let cache=caches.get(engine)
  if(!cache){cache=new TrustedInitializerCache(engine);caches.set(engine,cache)}
  return cache.use(engine,source,()=>{
    const input=context.newString(source)
    try{
      const filename=context.newString(name)
      try{
        const compiled=context.unwrapResult(context.compileTrustedInitializerWithFilename!(input,filename))
        try{
          const view=context.getArrayBuffer(compiled)
          try{return view.value.slice()}finally{view.dispose()}
        }finally{compiled.dispose()}
      }finally{filename.dispose()}
    }finally{input.dispose()}
  },bytes=>{
    const input=context.newArrayBuffer(bytes.buffer as ArrayBuffer)
    try{return context.evalTrustedInitializer!(input)}finally{input.dispose()}
  })
}
