import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'

// Small native regression for the padded C stack's ownership and accounting.
const stackBytes=512*1024
const memoryLimit=16*1024*1024
for(const combined of [false,true]){
  const root=resolve(`public/quickjs-als-asyncify${combined?'-wasm':''}-atomics-fibers-shared-storage`)
  const core=await import(pathToFileURL(join(root,'core.mjs')).href)
  const {default:factory}=await import(pathToFileURL(join(root,'engine.mjs')).href)
  const {QuickJSAsyncFFI}=await import(pathToFileURL(join(root,'ffi.mjs')).href)
  const engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>QuickJSAsyncFFI,importModuleLoader:async()=>async()=>factory({wasmBinary:readFileSync(join(root,'engine.wasm'))})})
  const runtime=engine.newRuntime(),context=runtime.newContext()
  runtime.setMemoryLimit(memoryLimit)
  runtime.setMaxStackSize(256*1024)
  const deadline=performance.now()+5000
  runtime.setInterruptHandler(()=>performance.now()>deadline)
  const evaluate=source=>context.unwrapResult(context.evalCode(source))
  const initializer=evaluate('park=>{globalThis.park=park}')
  context.unwrapResult(context.initializeFiber(initializer)).dispose();initializer.dispose()
  const complete=evaluate('()=>42'),parked=evaluate('()=>{park();return 99}')
  const stats=()=>{
    const handle=runtime.computeMemoryUsage()
    try{const value=context.dump(handle);return {bytes:value.malloc_size,count:value.malloc_count}}
    finally{handle.dispose()}
  }
  const run=cancel=>{
    const task=context.startFiberCall(cancel?parked:complete)
    if(cancel){assert.equal(task.step(),1);assert.equal(task.cancel(),true)}
    assert.equal(task.step(),2)
    const result=task.takeResult()
    try{
      if(cancel){assert.ok(result.error);assert.match(context.dump(result.error).message,/cancelled/)}
      else{assert.ok(result.value);assert.equal(context.getNumber(result.value),42)}
    }finally{result.dispose();task.dispose()}
  }
  try{
    // Warm the service context and cancellation error atoms before exact checks.
    stats();run(false);run(true);stats()
    const baseline=stats()
    const task=context.startFiberCall(complete)
    const allocated=stats()
    assert.ok(allocated.bytes-baseline.bytes>=3*stackBytes+15,'All three stacks, including alignment padding, are accounted')
    assert.equal(task.step(),2)
    task.takeResult().dispose();task.dispose()
    assert.deepEqual(stats(),baseline,'Completion releases the original padded allocation')
    for(let iteration=0;iteration<8;iteration++){
      run(false);run(true)
      assert.deepEqual(stats(),baseline,`No allocation drift after completion/cancellation pair ${iteration}`)
    }
    // Fail before each successive stack allocation, without allocating large heaps.
    for(const allowance of [256*1024,768*1024,1280*1024]){
      for(let iteration=0;iteration<3;iteration++){
        runtime.setMemoryLimit(baseline.bytes+allowance)
        try{assert.throws(()=>context.startFiberCall(complete),/Cannot create fiber call/)}
        finally{runtime.setMemoryLimit(memoryLimit)}
        // The wrapper reports a null task without taking QuickJS's pending OOM.
        // Replace and consume that exception before measuring stack ownership.
        const cleared=context.evalCode('throw 0')
        assert.ok(cleared.error);cleared.dispose()
        assert.deepEqual(stats(),baseline,`Partial creation cleanup with ${allowance} bytes available`)
        run(false)
        assert.deepEqual(stats(),baseline,'Creation failure leaves the runtime usable')
      }
    }
    console.log(JSON.stringify({combined,baseline,activeAllocationBytes:allocated.bytes-baseline.bytes,completionCancellationPairs:8,allocationFailures:9,passed:true}))
  }finally{complete.dispose();parked.dispose();context.dispose();runtime.dispose()}
}
