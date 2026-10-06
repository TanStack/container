import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {attachNativeWorkerProfiler,boundedNativeWorkerCPUProfile} from '../scripts/native-worker-cpu-profile.mjs'

test('worker transport routes only its own responses and removes listeners',async()=>{
  const parent=new EventEmitter(),sent=[]
  parent.send=async(method,params)=>{
    sent.push({method,params})
    if(method==='Target.attachToTarget')return {sessionId:'ours'}
    if(method==='Target.sendMessageToTarget'){
      const {id}=JSON.parse(params.message)
      queueMicrotask(()=>{
        parent.emit('Target.receivedMessageFromTarget',{sessionId:'other',message:JSON.stringify({id,result:{wrong:true}})})
        parent.emit('Target.receivedMessageFromTarget',{sessionId:'ours',message:JSON.stringify({id,result:{ok:true}})})
      })
    }
    return {}
  }
  const session=await attachNativeWorkerProfiler(parent,'worker')
  assert.deepEqual(await session.send('Profiler.enable'),{ok:true})
  assert.deepEqual(sent[0].params,{targetId:'worker',flatten:false})
  await session.detach()
  assert.equal(parent.listenerCount('Target.receivedMessageFromTarget'),0)
  assert.equal(parent.listenerCount('Target.detachedFromTarget'),0)
  await assert.rejects(session.send('Profiler.start'),/detached/)
})

test('worker transport reports remote, routing and detach failures',async()=>{
  for(const kind of ['remote','routing','detach']){
    const parent=new EventEmitter()
    parent.send=async(method,params)=>{
      if(method==='Target.attachToTarget')return {sessionId:'ours'}
      if(method==='Target.sendMessageToTarget'){
        const {id}=JSON.parse(params.message)
        if(kind==='routing')throw Error('routing failed')
        if(kind==='remote')queueMicrotask(()=>parent.emit('Target.receivedMessageFromTarget',{
          sessionId:'ours',message:JSON.stringify({id,error:{message:'remote failed'}}),
        }))
        if(kind==='detach')queueMicrotask(()=>parent.emit('Target.detachedFromTarget',{sessionId:'ours'}))
      }
      return {}
    }
    const session=await attachNativeWorkerProfiler(parent,'worker')
    await assert.rejects(session.send('Profiler.start'),kind==='detach'?/detached/:new RegExp(kind+' failed'))
    await session.detach();assert.equal(parent.listenerCount('Target.receivedMessageFromTarget'),0)
  }
})

test('failed target detachment still removes transport listeners',async()=>{
  const parent=new EventEmitter()
  parent.send=async method=>{if(method==='Target.detachFromTarget')throw Error('detach failed');return {sessionId:'ours'}}
  const session=await attachNativeWorkerProfiler(parent,'worker')
  await assert.rejects(session.detach(),/detach failed/)
  assert.equal(parent.listenerCount('Target.receivedMessageFromTarget'),0)
  assert.equal(parent.listenerCount('Target.detachedFromTarget'),0)
})

function setup(options){
  const calls=[],output=[]
  const session={send:async(method,params)=>{
    calls.push({method,params});return method==='Profiler.stop'?{profile:{nodes:[],samples:[],timeDeltas:[]}}:{}
  },detach:async()=>calls.push({method:'detach'})}
  return {session,calls,output,profile:boundedNativeWorkerCPUProfile(session,{writeProfile:bytes=>output.push(bytes),...options})}
}

test('worker profile sets a coarser interval and captures one complete result',async()=>{
  const {profile,calls,output}=setup()
  await profile.start();await profile.start()
  const stopped=profile.stop('ready');assert.equal(stopped,profile.stop('cleanup'))
  const result=await stopped
  assert.equal(result.complete,true)
  assert.deepEqual(calls.map(row=>row.method),['Profiler.enable','Profiler.setSamplingInterval','Profiler.start','Profiler.stop','Profiler.disable','detach'])
  assert.deepEqual(calls[1].params,{interval:5000})
  assert.equal(result.bytes,output[0].length)
})

test('worker profile keeps overflow, output and protocol errors separate',async()=>{
  for(const kind of ['overflow','sink','Profiler.stop','Profiler.disable']){
    const {profile,session,output}=setup(kind==='overflow'?{maxBytes:1}:kind==='sink'?{writeProfile:()=>{throw Error('sink failed')}}:{})
    if(kind.startsWith('Profiler.')){const send=session.send;session.send=(method,params)=>method===kind?Promise.reject(Error(kind+' failed')):send(method,params)}
    await profile.start();const result=await profile.stop('ready')
    assert.equal(result.complete,false,kind);assert.ok(result.errors.length)
    if(kind==='overflow'||kind==='sink')assert.equal(output.length,0)
  }
})

test('worker profile duration cap is independent of workload completion',async()=>{
  const timers=new Set(),{profile,calls}=setup({
    setTimer:(callback,ms)=>{const timer={callback,ms};timers.add(timer);return timer},clearTimer:timer=>timers.delete(timer),
  })
  await profile.start();[...timers].find(timer=>timer.ms===20000).callback()
  assert.equal((await profile.stop('cleanup')).stopReason,'duration-limit')
  assert.equal(timers.size,0);assert.equal(calls.at(-1).method,'detach')
})

test('worker profile cleanup before the trigger does not enable profiling',async()=>{
  const {profile,calls}=setup()
  assert.equal((await profile.stop('cleanup')).stopReason,'not-started')
  await profile.start();assert.deepEqual(calls,[{method:'detach'}])
})
