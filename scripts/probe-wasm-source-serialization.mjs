import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'

// Tiny ordinary module exporting answer() = 42. No imports or linear memory.
const bytes=[0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,
  7,10,1,6,97,110,115,119,101,114,0,0,10,6,1,4,0,65,42,11]
const original=new Uint8Array(bytes)
const nativeModule=new WebAssembly.Module(original)
original.fill(0)
const nativeInstance=new WebAssembly.Instance(nativeModule)
assert.equal(nativeInstance.exports.answer(),42)
const expected={originalMutation:42,existingInstance:42,newInstance:42,roundtrip:42,independentBuffers:true,serializedLength:bytes.length}

const root=resolve('public/quickjs-als-asyncify-wasm-atomics-fibers-shared-storage')
const core=await import(pathToFileURL(join(root,'core.mjs')).href)
const {default:factory}=await import(pathToFileURL(join(root,'engine.mjs')).href)
const {QuickJSAsyncFFI}=await import(pathToFileURL(join(root,'ffi.mjs')).href)
const engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>QuickJSAsyncFFI,importModuleLoader:async()=>()=>factory({wasmBinary:readFileSync(join(root,'engine.wasm'))})})
const runtime=engine.newRuntime()
runtime.setMemoryLimit(16*1024*1024)
runtime.setMaxStackSize(256*1024)
const context=runtime.newContext()
try{
  const source=`globalThis.__webContainerHost={};
${readFileSync('src/sandbox/guest-wasm.js','utf8')}
;(()=>{
 const check=(ok,label)=>{if(!ok)throw Error(label)};
 const bytes=${JSON.stringify(bytes)},input=new Uint8Array(bytes);
 const module=new WebAssembly.Module(input);input.fill(0);
 const instance=new WebAssembly.Instance(module);
 const originalMutation=instance.exports.answer();
 const api=__webContainerHost.wasmModule;
 const first=api.bytes(module),second=api.bytes(module);
 check(first instanceof ArrayBuffer&&second instanceof ArrayBuffer,'serialization returns ArrayBuffers');
 check(first!==second,'serialization returns independent buffers');
 check(JSON.stringify(Array.from(new Uint8Array(first)))===JSON.stringify(bytes),'first serialization preserves original input');
 new Uint8Array(first).fill(0);
 check(JSON.stringify(Array.from(new Uint8Array(second)))===JSON.stringify(bytes),'second serialization unaffected by first mutation');
 const roundtripModule=api.fromBytes(second);
 new Uint8Array(second).fill(0);
 const third=api.bytes(module);
 check(JSON.stringify(Array.from(new Uint8Array(third)))===JSON.stringify(bytes),'module source remains unchanged after both serialization mutations');
 return JSON.stringify({originalMutation,existingInstance:instance.exports.answer(),newInstance:new WebAssembly.Instance(module).exports.answer(),roundtrip:new WebAssembly.Instance(roundtripModule).exports.answer(),independentBuffers:first!==second,serializedLength:third.byteLength});
})()`
  const result=context.evalCode(source,'source-serialization.js')
  if(result.error){const error=context.dump(result.error);result.dispose();throw Error(JSON.stringify(error))}
  let actual
  try{actual=JSON.parse(context.getString(result.value))}finally{result.value.dispose()}
  assert.deepEqual(actual,expected)
  console.log(JSON.stringify({scope:'Native input-mutation reference plus guest module serialization fresh-copy checks',engine:root,expected,actual}))
}finally{context.dispose();runtime.dispose()}
