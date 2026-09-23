import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'

for(const guestWasm of [false,true]){
  const root=resolve(`public/quickjs-als-asyncify${guestWasm?'-wasm':''}-atomics-fibers-shared-storage`)
  const core=await import(pathToFileURL(join(root,'core.mjs')).href)
  const {default:factory}=await import(pathToFileURL(join(root,'engine.mjs')).href)
  const {QuickJSAsyncFFI}=await import(pathToFileURL(join(root,'ffi.mjs')).href)
  const create=()=>core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>QuickJSAsyncFFI,importModuleLoader:async()=>()=>factory({wasmBinary:readFileSync(join(root,'engine.wasm'))})})
  const stats=context=>{
    const value=context.unwrapResult(context.sharedStorageStats())
    try{return context.dump(value)}finally{value.dispose()}
  }
  const engine=await create()
  for(const value of [NaN,Infinity,-Infinity,65536.5,65535,1536*1024*1024+1]){
    assert.throws(()=>engine.configureSharedStorage(value),RangeError)
  }
  engine.configureSharedStorage(131072)
  engine.configureSharedStorage(131072)
  assert.throws(()=>engine.configureSharedStorage(262144),/already fixed/)
  const runtime=engine.newRuntime(),context=runtime.newContext()
  let full
  try{
    context.unwrapResult(context.evalCode('globalThis.buffer=new SharedArrayBuffer(131072)')).dispose()
    full=stats(context)
    assert.equal(full.bytes,131072)
    assert.equal(full.maxBytes,131072)
    assert.equal(full.configured,1)
    const failed=context.evalCode('new SharedArrayBuffer(1)')
    try{assert.ok(failed.error,'Allocation beyond configured budget must fail')}finally{failed.dispose()}
    assert.equal(stats(context).bytes,131072)
  }finally{context.dispose();runtime.dispose()}
  assert.throws(()=>engine.configureSharedStorage(262144),/already fixed/)
  const observerRuntime=engine.newRuntime(),observer=observerRuntime.newContext()
  let empty
  try{
    empty=stats(observer)
    for(const name of ['bytes','allocations','references','wrappers','leases'])assert.equal(empty[name],0,name)
  }finally{observer.dispose();observerRuntime.dispose()}
  const defaultEngine=await create(),defaultRuntime=defaultEngine.newRuntime()
  defaultRuntime.dispose()
  defaultEngine.configureSharedStorage(16*1024*1024)
  assert.throws(()=>defaultEngine.configureSharedStorage(262144),/already fixed/)
  const defaultObserverRuntime=defaultEngine.newRuntime(),defaultObserver=defaultObserverRuntime.newContext()
  let defaultStats
  try{
    defaultStats=stats(defaultObserver)
    assert.equal(defaultStats.maxBytes,16*1024*1024)
    assert.equal(defaultStats.configured,1)
  }finally{defaultObserver.dispose();defaultObserverRuntime.dispose()}
  console.log(JSON.stringify({guestWasm,status:'passed',full,afterDisposal:empty,defaultAfterRuntimeDisposal:defaultStats}))
}
