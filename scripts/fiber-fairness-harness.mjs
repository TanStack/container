import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'

// Baseline only: successful arithmetic is not evidence of preemptive fairness.
if(!process.env.SDK_OUTPUT)throw Error('Set SDK_OUTPUT to the packaged SDK directory')
const sdk=resolve(process.env.SDK_OUTPUT)
const compute=count=>{let total=0;for(let i=0;i<count;i++)total=(total+(i%97))%1000000007;return total}
const reports=[]
for(const combined of [false,true]){
 const root=join(sdk,`runtime/quickjs-als-asyncify${combined?'-wasm':''}-atomics-fibers-shared-storage`)
 const core=await import(pathToFileURL(join(root,'core.mjs')).href)
 const {default:factory}=await import(pathToFileURL(join(root,'engine.mjs')).href)
 const {QuickJSAsyncFFI}=await import(pathToFileURL(join(root,'ffi.mjs')).href)
 const engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>QuickJSAsyncFFI,importModuleLoader:async()=>async()=>factory({wasmBinary:readFileSync(join(root,'engine.wasm'))})})
 const deadline=performance.now()+5000,events=[],tasks=new Set()
 const states=[0,1].map(index=>{
  const runtime=engine.newRuntime();runtime.setMemoryLimit(16*1024*1024);runtime.setMaxStackSize(256*1024);runtime.setInterruptHandler(()=>performance.now()>deadline)
  const context=runtime.newContext(),initializer=context.unwrapResult(context.evalCode('park=>{globalThis.park=park}'))
  context.unwrapResult(context.initializeFiber(initializer)).dispose();initializer.dispose()
  const count=1000000+index*1000,fn=context.unwrapResult(context.evalCode(`()=>(${compute.toString()})(${count})`))
  const fiber=context.startFiberCall(fn);fn.dispose();tasks.add(fiber)
  return {runtime,context,fiber,count}
 })
 try{
  for(const [index,state] of states.entries()){
   const begin=performance.now(),status=state.fiber.step()
   events.push({runtime:index,firstStepStatus:status,elapsedMs:performance.now()-begin,completedEntireTask:status===2})
   // Current baseline has no implicit CPU yield. A future candidate must update
   // this harness to drive its explicit fairness protocol, not timer delivery.
   assert.equal(status,2,'Current baseline finite CPU work completes in one step')
   const result=state.fiber.takeResult()
   try{assert.ok(result.value);const actual=state.context.getNumber(result.value);assert.equal(actual,compute(state.count));events.at(-1).result=actual}finally{result.dispose();state.fiber.dispose();tasks.delete(state.fiber)}
  }
  const {context}=states[0],fn=context.unwrapResult(context.evalCode('()=>{park();return 42}')),parked=context.startFiberCall(fn)
  tasks.add(parked);assert.equal(parked.step(),1)
  assert.throws(()=>context.startFiberCall(fn))
  const peer=states[1].context,peerResult=peer.unwrapResult(peer.evalCode('6*7'));assert.equal(peer.getNumber(peerResult),42);peerResult.dispose()
  assert.equal(parked.deliver(0),true);assert.equal(parked.step(),2)
  const value=parked.takeResult();try{assert.equal(context.getNumber(value.value),42)}finally{value.dispose();parked.dispose();tasks.delete(parked);fn.dispose()}
  reports.push({combined,events,sameRuntimeSecondFiberRejected:true,peerProgressWhileExplicitlyParked:true,fairness:'No implicit CPU yield observed'})
 }finally{
  for(const task of tasks){task.cancel();task.step();task.takeResult().dispose();task.dispose()}
  for(const {context,runtime} of states){context.dispose();runtime.dispose()}
 }
}
console.log(JSON.stringify({sdk,scope:'Finite CPU fairness baseline, not a scheduling capability claim',reports},null,2))
