// Bounded host-only probe. Requires a rebuilt compiled-initializers profile.
import {readFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import assert from 'node:assert/strict'

const root=resolve(process.argv[2]??'public/quickjs-als-asyncify-wasm-o2-atomics-assignments-fibers-shared-storage-simd-lazy-wasm-compiled-initializers')
const core=await import(pathToFileURL(join(root,'core.mjs')).href)
const {default:factory}=await import(pathToFileURL(join(root,'engine.mjs')).href)
const {QuickJSAsyncFFI}=await import(pathToFileURL(join(root,'ffi.mjs')).href)
const engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>QuickJSAsyncFFI,importModuleLoader:async()=>()=>factory({wasmBinary:readFileSync(join(root,'engine.wasm'))})})
let bytes
for(let index=0;index<3;index++){
  const runtime=engine.newRuntime();runtime.setMemoryLimit(32*1024*1024)
  const context=runtime.newContext()
  try{
    if(index===0){
      const source=context.newString('(globalThis.initialized=1,function(){globalThis.calls=(globalThis.calls||0)+1;return {calls:globalThis.calls,stack:new Error("marker").stack}})'),name=context.newString('node:process')
      try{
        const compiled=context.unwrapResult(context.compileTrustedInitializerWithFilename(source,name))
        try{const view=context.getArrayBuffer(compiled);try{bytes=view.value.slice()}finally{view.dispose()}}finally{compiled.dispose()}
        const untouched=context.unwrapResult(context.evalCode('typeof initialized'))
        try{assert.equal(context.getString(untouched),'undefined')}finally{untouched.dispose()}
        for(const invalid of ['', 'bad\0name','x'.repeat(4097)]){
          // newString's C-string bridge truncates NUL. Construct the actual
          // guest string to exercise the filename validator, not that bridge.
          const value=context.unwrapResult(context.evalCode(JSON.stringify(invalid)))
          try{const result=context.compileTrustedInitializerWithFilename(source,value);try{assert.ok(result.error,JSON.stringify(invalid))}finally{result.dispose()}}finally{value.dispose()}
        }
        const old=context.unwrapResult(context.compileTrustedInitializer(source))
        old.dispose()
      }finally{source.dispose();name.dispose()}
    }else{
      const input=context.newArrayBuffer(bytes.buffer)
      try{
        const wrapper=context.unwrapResult(context.evalTrustedInitializer(input))
        try{
          assert.equal(context.typeof(wrapper),'function')
          const value=context.unwrapResult(context.callFunction(wrapper,context.undefined))
          try{const result=context.dump(value);assert.equal(result.calls,1);assert.match(result.stack,/node:process/)}finally{value.dispose()}
        }finally{wrapper.dispose()}
      }finally{input.dispose()}
    }
  }finally{context.dispose();runtime.dispose()}
}
console.log(JSON.stringify({passed:true,compiledBytes:bytes.length,freshContexts:2,filename:'node:process'}))
