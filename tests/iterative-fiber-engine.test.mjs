import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'

test('iterative fiber engine preserves deep calls, unwind, ALS and fiber ownership',async()=>{
  const root=resolve(process.env.ITERATIVE_FIBER_ENGINE??'public/quickjs-als-asyncify-wasm-o2-atomics-fibers-shared-storage-simd-lazy-wasm-compiled-initializers-iterative-calls')
  const core=await import(pathToFileURL(join(root,'core.mjs')).href)
  const {default:factory}=await import(pathToFileURL(join(root,'engine.mjs')).href)
  const {QuickJSAsyncFFI}=await import(pathToFileURL(join(root,'ffi.mjs')).href)
  const engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>QuickJSAsyncFFI,importModuleLoader:async()=>async()=>factory({wasmBinary:readFileSync(join(root,'engine.wasm'))})})
  const runtime=engine.newRuntime(),context=runtime.newContext()
  runtime.setMemoryLimit(64*1024*1024);runtime.setMaxStackSize(256*1024)
  const deadline=Date.now()+15000;runtime.setInterruptHandler(()=>Date.now()>deadline)
  const evaluate=source=>context.unwrapResult(context.evalCode(source))
  const value=source=>{const handle=evaluate(source);try{return context.dump(handle)}finally{handle.dispose()}}
  try{
    assert.equal(value('function deep(n){return n?1+deep(n-1):0};deep(500)'),500)
    assert.equal(value('const object={deep(n){return n?1+this.deep(n-1):0}};object.deep(500)'),500)
    assert.deepEqual(value('let unwound=0;function fail(n){try{if(n)return fail(n-1);throw Error("owned")}finally{unwound++}};let caught;try{fail(500)}catch(e){caught=e.message};[caught,unwound,deep(500)]'),['owned',501,500])
    const overflow=context.evalCode('deep(4200)');assert.ok(overflow.error);assert.match(context.dump(overflow.error).message,/stack overflow/);overflow.dispose()
    assert.equal(value('deep(500)'),500)
    evaluate(readFileSync('src/sandbox/engine-als-bootstrap.js','utf8')).dispose()
    evaluate('globalThis.als=new __engineAsyncLocalStorage();globalThis.seen=[];for(const id of ["A","B"])als.run(id,()=>Promise.resolve().then(()=>{deep(500);seen.push(als.getStore())}));').dispose()
    while(runtime.hasPendingJob())context.unwrapResult(runtime.executePendingJobs(100))
    assert.deepEqual(value('seen'),['A','B'])
    const initializer=evaluate('park=>{globalThis.park=park}');context.unwrapResult(context.initializeFiber(initializer)).dispose();initializer.dispose()
    const fn=evaluate('()=>{function nested(n){return n?1+nested(n-1):(park(),0)};return nested(500)}')
    try{for(const cancel of [false,true,false]){
      const task=context.startFiberCall(fn)
      try{assert.equal(task.step(),1);if(cancel)assert.equal(task.cancel(),true);else assert.equal(task.deliver(0),true);assert.equal(task.step(),2);const result=task.takeResult();try{if(cancel){assert.ok(result.error);assert.match(context.dump(result.error).message,/cancelled/)}else{assert.ok(result.value);assert.equal(context.getNumber(result.value),500)}}finally{result.dispose()}}
      catch(error){console.error('Fiber assertion:',{cancel,error});throw error}
      finally{if(task.status()!==2){task.cancel();task.step();task.takeResult().dispose()}task.dispose()}
    }}finally{fn.dispose()}
    const parser=readFileSync('fixtures/start-vite8-wasm/node_modules/@babel/parser/lib/index.js','utf8')
    evaluate(`globalThis.babel=(function(){const exports={};${parser}\nreturn exports})()`).dispose()
    assert.equal(value('babel.parse("const value = "+"f(".repeat(30)+"0"+")".repeat(30),{sourceType:"module"}).program.body[0].type'),'VariableDeclaration')
  }catch(error){console.error('Primary engine failure:',error);throw error}
  finally{try{context.dispose();runtime.dispose()}catch(error){console.error('Engine cleanup failure:',error);throw error}}
})
