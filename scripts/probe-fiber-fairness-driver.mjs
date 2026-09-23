import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {build} from 'esbuild'
const bundle=await build({stdin:{contents:`export {runKernelFiber} from './src/sandbox/fiber-engine.ts';export {EngineAccess} from './src/sandbox/engine-access.ts';export {TaskScheduler} from './src/sandbox/task-scheduler.ts'`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false})
const {runKernelFiber,EngineAccess,TaskScheduler}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'))
const root=resolve('public/quickjs-als-asyncify-atomics-fibers-shared-storage-fiber-fairness')
const core=await import(pathToFileURL(join(root,'core.mjs')).href)
const {default:factory}=await import(pathToFileURL(join(root,'engine.mjs')).href)
const {QuickJSAsyncFFI}=await import(pathToFileURL(join(root,'ffi.mjs')).href)
const engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>QuickJSAsyncFFI,importModuleLoader:async()=>async()=>factory({wasmBinary:readFileSync(join(root,'engine.wasm'))})})
const compute=count=>{let total=0;for(let i=0;i<count;i++)total=(total+i%97)%1000000007;return total}
const deadline=performance.now()+5000,states=[],events=[],observerErrors=[]
let takeWaitCalls=0,deliverCalls=0,timerProgress=false
function make(){
 const runtime=engine.newRuntime();runtime.setMemoryLimit(16*1024*1024);runtime.setMaxStackSize(256*1024);runtime.setInterruptHandler(()=>performance.now()>deadline)
 const state={runtime,context:runtime.newContext(),access:new EngineAccess(),scheduler:new TaskScheduler(),done:false,yields:0};states.push(state);return state
}
function start(state,count){const fn=state.context.unwrapResult(state.context.evalCode(`()=>(${compute.toString()})(${count})`));try{return state.context.startFiberCall(fn)}finally{fn.dispose()}}
async function drive(state,count,controller,cancelOnYield=false){
 const fiber=start(state,count),deliver=fiber.deliver.bind(fiber);fiber.deliver=value=>{deliverCalls++;return deliver(value)}
 const result=await state.access.run(()=>runKernelFiber(fiber,{scheduler:state.scheduler,signal:controller.signal,expired:()=>performance.now()>deadline,takeWait:()=>{takeWaitCalls++;throw Error('CPU fairness requested a timer wait')},onStep:(_duration,status)=>{
  try{assert.equal(state.access.busy,true);events.push({runtime:states.indexOf(state),status})
  if(status===3){state.yields++;if(state.yields===1){state.access.enqueue(()=>{assert.equal(state.done,true)});assert.throws(()=>state.access.drain(),/executing/)}if(cancelOnYield)controller.abort()}
  }catch(error){observerErrors.push(error.message)}
 }}))
 try{if(cancelOnYield){assert.ok(result.error);return {cancelled:true,error:state.context.dump(result.error)}}assert.equal(result.error,undefined);assert.equal(state.context.getNumber(result.value),compute(count));return {answer:compute(count)}}
 finally{result.dispose();state.done=true;assert.equal(state.access.busy,false);state.access.drain()}
}
try{
 const a=make(),b=make()
 const timer=setTimeout(()=>{timerProgress=!a.done&&!b.done;assert.equal(a.access.busy,true);assert.equal(b.access.busy,true)},0)
 let results
 try{results=await Promise.all([drive(a,1000000,new AbortController()),drive(b,1001000,new AbortController())])}finally{clearTimeout(timer)}
 assert.ok(timerProgress);assert.ok(a.yields>0&&b.yields>0)
 const firstDone=events.findIndex(event=>event.status===2)
 assert.ok(events.slice(0,firstDone).some(event=>event.runtime===0&&event.status===3));assert.ok(events.slice(0,firstDone).some(event=>event.runtime===1&&event.status===3))
 a.done=false;a.yields=0
 const cancelled=await drive(a,1000000,new AbortController(),true)
 assert.deepEqual(observerErrors,[]);assert.equal(takeWaitCalls,0);assert.equal(deliverCalls,0)
 console.log(JSON.stringify({scope:'Actual runKernelFiber driver with isolated JS fairness candidate, not SDK acceptance',root,results,cancelled,peerProgress:true,timerProgress,locksRetained:true,queuedCompletionsAfterExit:true,takeWaitCalls,deliverCalls,steps:events.length}))
}finally{for(const state of states){state.scheduler.close();state.access.close();state.context.dispose();state.runtime.dispose()}}
