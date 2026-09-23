import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import assert from 'node:assert/strict'
import {test} from 'node:test'

const defaultBaseline='public/quickjs-als-asyncify-wasm-o2-atomics-one-caller50-assignments-fibers-shared-storage-simd-lazy-wasm-compiled-initializers-iterative-calls-module-import-exports'
const baselineRoot=resolve(process.env.INTERPRETER_SEGMENT_BASELINE_ENGINE??defaultBaseline)
const baselineSHA256=process.env.INTERPRETER_SEGMENT_BASELINE_SHA256??'004e6b91a65a977284491dedc0906bbf3bc798cde50e7da6050db2b86e42ab29'
const roots=[baselineRoot]
if(process.env.INTERPRETER_SEGMENT_ENGINE)roots.push(resolve(process.env.INTERPRETER_SEGMENT_ENGINE))

function sha256(bytes){return createHash('sha256').update(bytes).digest('hex')}

function unwrap(context,result){
  if(result.error){
    const error=context.dump(result.error)
    result.dispose()
    throw Error(JSON.stringify(error))
  }
  return result.value
}

async function openEngine(root){
  const wasm=readFileSync(join(root,'engine.wasm'))
  const core=await import(pathToFileURL(join(root,'core.mjs')).href)
  const {default:factory}=await import(pathToFileURL(join(root,'engine.mjs')).href)
  const {QuickJSAsyncFFI}=await import(pathToFileURL(join(root,'ffi.mjs')).href)
  const engine=await core.newQuickJSAsyncWASMModuleFromVariant({
    type:'async',
    importFFI:async()=>QuickJSAsyncFFI,
    importModuleLoader:async()=>async()=>factory({wasmBinary:wasm}),
  })
  return {engine,wasmSHA256:sha256(wasm)}
}

function startCall(context,source){
  const fn=unwrap(context,context.evalCode(source))
  try{return context.startFiberCall(fn)}finally{fn.dispose()}
}

function finishFiber(context,fiber,delivered=40){
  assert.equal(fiber.step(),1,'fixture must park')
  assert.equal(fiber.deliver(delivered),true,'fixture must accept the resume value')
  assert.equal(fiber.step(),2,'fixture must finish after resume')
  return fiber.takeResult()
}

async function drainJobs(runtime,context){
  while(runtime.hasPendingJob()){
    const jobs=await runtime.executePendingJobs(100)
    try{assert.ok(!jobs.error,jobs.error?JSON.stringify(context.dump(jobs.error)):'pending jobs failed')}
    finally{jobs.dispose()}
  }
}

const callCases=[
  {
    name:'cross-family branches consume wide operands once after suspension',
    source:`()=>{const values=[1,2,3,4];let sum=park();for(let i=0;i<values.length;i++){if(i%2===0){sum+=values[i]*3}else{sum-=values[i]}}return {sum,wide:sum+70000,zero:!sum}}`,
    expected:{sum:46,wide:70046,zero:false},
  },
  {
    name:'parent frame restores its own locals and properties after child resume',
    source:`()=>{function hop(n){const frame={value:n};if(n===0)return park();const child=hop(n-1);return frame.value+child}return hop(4)}`,
    expected:50,
  },
  {
    name:'generator throw restarts the right frame after yield and catch',
    source:`()=>{const events=[];function* values(){try{yield park()+1}catch(error){yield error.message.length+70000}finally{events.push('done')}}const iterator=values(),first=iterator.next(),second=iterator.throw(Error('abc')),third=iterator.next();return [first.value,second.value,third.done,events]}`,
    expected:[41,70003,true,['done']],
  },
  {
    name:'bytecode call returns through its caller',
    source:`()=>{function inner(){return park()+2}function outer(){return inner()}return outer()}`,
    expected:42,
  },
  {
    name:'native Array callback returns into bytecode',
    source:`()=>[2].map(value=>park()+value)[0]`,
    expected:42,
  },
  {
    name:'tail position call returns to its parent',
    source:`()=>{function target(){return park()+3}function tail(){'use strict';return target()}return tail()}`,
    expected:43,
  },
  {
    name:'bytecode constructor completes after resume',
    source:`()=>{class Box{constructor(){this.value=park()+4}}return new Box().value}`,
    expected:44,
  },
  {
    name:'native constructor resumes coercion callback',
    source:`()=>Number(new Number({valueOf(){return park()+5}}))`,
    expected:45,
  },
  {
    name:'direct eval returns through caller',
    source:`()=>eval('park()+6')`,
    expected:46,
  },
  {
    name:'generator next yields after resume',
    source:`()=>{function* values(){yield park()+7}return values().next().value}`,
    expected:47,
  },
  {
    name:'yield delegation returns through outer generator',
    source:`()=>{function* inner(){yield park()+8}function* outer(){yield* inner()}return outer().next().value}`,
    expected:48,
  },
  {
    name:'generator return runs finally after resumed yield',
    source:`()=>{const events=[];function* values(){try{yield park()+9}finally{events.push('finally')}}const iterator=values();const first=iterator.next();const returned=iterator.return(99);return [first,returned,events]}`,
    expected:[{value:49,done:false},{value:99,done:true},['finally']],
  },
  {
    name:'native callback throw unwinds iterative callers and finally blocks',
    source:`()=>{let unwound=0;function deep(n){try{if(n)return deep(n-1);return [1].map(()=>{park();throw Error('native callback boom')})}finally{unwound++}}let message;try{deep(100)}catch(error){message=error.message}return [message,unwound]}`,
    expected:['native callback boom',101],
  },
]

const boundaryKinds={
  iterator:{
    returned:`()=>{let count=0;const iterable={[Symbol.iterator](){return {next(){if(count++)return {done:true};return {value:park()+1,done:false}}}}};return [...iterable][0]}`,
    thrown:`()=>{const events=[];const iterable={[Symbol.iterator](){return {next(){events.push('next');park();throw Error('iterator boom')}}}};try{[...iterable]}catch(error){events.push(error.message)}return events.join(':')}`,
    expected:41,
    thrownExpected:'next:iterator boom',
  },
  proxy:{
    returned:`()=>new Proxy({},{get(){return park()+2}}).value`,
    thrown:`()=>{const events=[];const proxy=new Proxy({},{get(){events.push('get');park();throw Error('proxy boom')}});try{proxy.value}catch(error){events.push(error.message)}return events.join(':')}`,
    expected:42,
    thrownExpected:'get:proxy boom',
  },
  coercion:{
    returned:`()=>({valueOf(){return park()}})+3`,
    thrown:`()=>{const events=[];const value={valueOf(){events.push('coerce');park();throw Error('coercion boom')}};try{value+1}catch(error){events.push(error.message)}return events.join(':')}`,
    expected:43,
    thrownExpected:'coerce:coercion boom',
  },
}

for(const root of roots)test(`segmented interpreter preserves typed transitions: ${root}`,async t=>{
  const {engine,wasmSHA256}=await openEngine(root)
  if(root===baselineRoot)assert.equal(wasmSHA256,baselineSHA256,'baseline engine identity changed')
  t.diagnostic(JSON.stringify({root,wasmSHA256,role:root===baselineRoot?'baseline':'candidate'}))
  const runtime=engine.newRuntime(),context=runtime.newContext()
  runtime.setMemoryLimit(64*1024*1024)
  runtime.setMaxStackSize(1024*1024)
  const deadline=Date.now()+30_000
  runtime.setInterruptHandler(()=>Date.now()>deadline)
  const evaluate=source=>unwrap(context,context.evalCode(source))
  runtime.setModuleLoader(name=>{
    if(name==='suspended-dependency')return `export const value=park()+8`
    if(name==='async-dependency')return `export const value=park()+9`
    throw Error('Unknown transition fixture module '+name)
  },(_base,name)=>name)
  let fiberJobs,executeJobs,jobLimit
  try{
    executeJobs=context.getProp(context.global,'__qjsExecutePendingJobs')
    jobLimit=context.newNumber(100)
    const jobFactory=evaluate('(pump,limit)=>()=>pump(limit)')
    try{fiberJobs=unwrap(context,context.callFunction(jobFactory,context.undefined,executeJobs,jobLimit))}
    finally{jobFactory.dispose()}
    evaluate(readFileSync('src/sandbox/engine-als-bootstrap.js','utf8')).dispose()
    const initializer=evaluate('park=>{globalThis.park=park;globalThis.als=new __engineAsyncLocalStorage()}')
    unwrap(context,context.initializeFiber(initializer)).dispose()
    initializer.dispose()

    for(const fixture of callCases){
      const fiber=startCall(context,fixture.source)
      try{
        const result=finishFiber(context,fiber)
        try{
          assert.ok(result.value,`${fixture.name} returned ${result.error?JSON.stringify(context.dump(result.error)):'no value'}`)
          assert.deepEqual(context.dump(result.value),fixture.expected,fixture.name)
        }finally{result.dispose()}
      }finally{fiber.dispose()}
    }

    const moduleFiber=context.startFiberEval(`import {value} from 'suspended-dependency';globalThis.moduleValue=value`,'transition-entry.mjs',1)
    try{
      const result=finishFiber(context,moduleFiber)
      result.dispose()
      const value=evaluate('moduleValue')
      try{assert.equal(context.getNumber(value),48)}finally{value.dispose()}
    }finally{moduleFiber.dispose()}

    const asyncFiber=startCall(context,`()=>als.run('await-scope',async()=>{const resumed=park();await Promise.resolve();return [resumed+10,als.getStore()]})`)
    let promise
    try{
      const result=finishFiber(context,asyncFiber)
      try{promise=unwrap(context,result).dup()}finally{result.dispose()}
    }finally{asyncFiber.dispose()}
    try{
      await drainJobs(runtime,context)
      const state=context.getPromiseState(promise)
      assert.equal(state.type,'fulfilled')
      try{assert.deepEqual(context.dump(state.value),[50,'await-scope'])}finally{state.value.dispose()}
    }finally{promise.dispose()}

    const asyncGeneratorFiber=startCall(context,`()=>{async function* values(){yield park()+11}return values().next()}`)
    try{
      const result=finishFiber(context,asyncGeneratorFiber)
      try{promise=unwrap(context,result).dup()}finally{result.dispose()}
    }finally{asyncGeneratorFiber.dispose()}
    try{
      await drainJobs(runtime,context)
      const state=context.getPromiseState(promise)
      assert.equal(state.type,'fulfilled')
      try{assert.deepEqual(context.dump(state.value),{value:51,done:false})}finally{state.value.dispose()}
    }finally{promise.dispose()}

    const dynamicImport=startCall(context,`()=>import('async-dependency').then(namespace=>namespace.value)`)
    try{
      assert.equal(dynamicImport.step(),2,'dynamic import returns a promise without parking outside an active fiber')
      const result=dynamicImport.takeResult()
      try{promise=unwrap(context,result).dup()}finally{result.dispose()}
    }finally{dynamicImport.dispose()}
    try{
      let parked=false
      while(runtime.hasPendingJob()){
        const jobFiber=context.startFiberCall(fiberJobs)
        try{
          let status=jobFiber.step()
          if(status===1){
            parked=true
            assert.equal(jobFiber.deliver(40),true)
            status=jobFiber.step()
          }
          assert.equal(status,2)
          const result=jobFiber.takeResult()
          if(result.error){const error=context.dump(result.error);result.dispose();throw Error(JSON.stringify(error))}
          result.dispose()
        }finally{jobFiber.dispose()}
      }
      assert.equal(parked,true,'dynamic import module evaluation must park inside the fiber-owned job pump')
      const state=context.getPromiseState(promise)
      assert.equal(state.type,'fulfilled')
      try{assert.equal(context.getNumber(state.value),49)}finally{state.value.dispose()}
    }finally{promise.dispose()}
    t.diagnostic('dynamic import module evaluation parks inside the same fiber-owned native job pump used by the production kernel')

    const generatorThrow=startCall(context,`()=>{function* values(){park();throw Error('generator boom')}try{values().next()}catch(error){return error.message}}`)
    try{
      const result=finishFiber(context,generatorThrow)
      try{assert.equal(context.dump(unwrap(context,result)),'generator boom')}finally{result.dispose()}
    }finally{generatorThrow.dispose()}

    evaluate(`globalThis.generatorCancelEvents=[]`).dispose()
    const generatorCancel=startCall(context,`()=>{function* values(){generatorCancelEvents.push('before');park();generatorCancelEvents.push('after');yield 1}return values().next()}`)
    try{
      assert.equal(generatorCancel.step(),1)
      assert.equal(generatorCancel.cancel(),true)
      assert.equal(generatorCancel.step(),2)
      const result=generatorCancel.takeResult()
      try{assert.ok(result.error);assert.match(context.dump(result.error).message,/cancelled/)}finally{result.dispose()}
    }finally{generatorCancel.dispose()}
    const generatorEvents=evaluate('generatorCancelEvents')
    try{assert.deepEqual(context.dump(generatorEvents),['before'])}finally{generatorEvents.dispose()}

    const awaitThrow=startCall(context,`()=>als.run('await-throw-scope',async()=>{park();await Promise.resolve();throw Error('await boom')})`)
    try{
      const result=finishFiber(context,awaitThrow)
      try{promise=unwrap(context,result).dup()}finally{result.dispose()}
    }finally{awaitThrow.dispose()}
    try{
      await drainJobs(runtime,context)
      const state=context.getPromiseState(promise)
      assert.equal(state.type,'rejected')
      try{assert.equal(context.dump(state.error).message,'await boom')}finally{state.error.dispose()}
    }finally{promise.dispose()}

    evaluate(`globalThis.awaitCancelEvents=[]`).dispose()
    const awaitCancel=startCall(context,`()=>als.run('await-cancel-scope',async()=>{awaitCancelEvents.push(['before',als.getStore()]);park();awaitCancelEvents.push(['after',als.getStore()]);await Promise.resolve();return 1})`)
    try{
      assert.equal(awaitCancel.step(),1)
      assert.equal(awaitCancel.cancel(),true)
      assert.equal(awaitCancel.step(),2)
      const result=awaitCancel.takeResult()
      try{promise=unwrap(context,result).dup()}finally{result.dispose()}
    }finally{awaitCancel.dispose()}
    try{
      await drainJobs(runtime,context)
      const state=context.getPromiseState(promise)
      assert.equal(state.type,'rejected')
      try{assert.match(context.dump(state.error).message,/cancelled/)}finally{state.error.dispose()}
    }finally{promise.dispose()}
    const awaitEvents=evaluate('awaitCancelEvents')
    try{assert.deepEqual(context.dump(awaitEvents),[['before','await-cancel-scope']])}finally{awaitEvents.dispose()}

    for(const [kind,fixture] of Object.entries(boundaryKinds)){
      const returned=startCall(context,fixture.returned)
      try{
        const result=finishFiber(context,returned)
        try{assert.deepEqual(context.dump(unwrap(context,result)),fixture.expected,`${kind} resume`)}finally{result.dispose()}
      }finally{returned.dispose()}

      const thrown=startCall(context,fixture.thrown)
      try{
        const result=finishFiber(context,thrown)
        try{assert.equal(context.dump(unwrap(context,result)),fixture.thrownExpected,`${kind} throw`)}finally{result.dispose()}
      }finally{thrown.dispose()}

      evaluate(`globalThis.${kind}CancelEvents=[]`).dispose()
      const cancelled=startCall(context,kind==='iterator'
        ? `()=>{const iterable={[Symbol.iterator](){return {next(){iteratorCancelEvents.push('before');park();iteratorCancelEvents.push('after');return {done:true}}}}};return [...iterable]}`
        : kind==='proxy'
          ? `()=>new Proxy({},{get(){proxyCancelEvents.push('before');park();proxyCancelEvents.push('after');return 1}}).value`
          : `()=>({valueOf(){coercionCancelEvents.push('before');park();coercionCancelEvents.push('after');return 1}})+1`)
      try{
        assert.equal(cancelled.step(),1,`${kind} cancellation must park`)
        assert.equal(cancelled.cancel(),true,`${kind} cancellation must be accepted`)
        assert.equal(cancelled.step(),2,`${kind} cancellation must unwind`)
        const result=cancelled.takeResult()
        try{
          assert.ok(result.error)
          assert.match(context.dump(result.error).message,/cancelled/)
        }finally{result.dispose()}
      }finally{cancelled.dispose()}
      const events=evaluate(`${kind}CancelEvents`)
      try{assert.deepEqual(context.dump(events),['before'],`${kind} cancelled continuation`)}finally{events.dispose()}
    }

    const deepALS=startCall(context,`()=>als.run('deep-scope',()=>{function deep(n){if(n)return deep(n-1)+1;park();return als.getStore()==='deep-scope'?0:-1000}return [deep(500),als.getStore()]})`)
    try{
      const result=finishFiber(context,deepALS,40)
      try{assert.deepEqual(context.dump(unwrap(context,result)),[500,'deep-scope'])}finally{result.dispose()}
    }finally{deepALS.dispose()}

    const recovered=evaluate('6*7')
    try{assert.equal(context.getNumber(recovered),42)}finally{recovered.dispose()}
  }finally{
    fiberJobs?.dispose()
    jobLimit?.dispose()
    executeJobs?.dispose()
    context.dispose()
    runtime.dispose()
  }
})
