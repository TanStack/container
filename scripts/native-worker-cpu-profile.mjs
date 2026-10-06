import assert from 'node:assert/strict'

// Use the public CDP target transport to profile an owned dedicated worker.
// Non-flat target sessions are supported by the pinned browser protocol.
export async function attachNativeWorkerProfiler(browserSession,targetId){
  assert.ok(typeof targetId==='string'&&targetId.length,'Missing worker target')
  const {sessionId}=await browserSession.send('Target.attachToTarget',{targetId,flatten:false})
  assert.ok(typeof sessionId==='string'&&sessionId.length,'Missing worker profiler session')
  let next=0,closed=false
  const pending=new Map()
  const close=()=>{
    closed=true
    for(const entry of pending.values())entry.reject(Error('Worker profiler session detached'))
    pending.clear()
  }
  const receive=event=>{
    if(event.sessionId!==sessionId)return
    let message
    try{message=JSON.parse(event.message)}catch{return}
    const entry=pending.get(message.id)
    if(!entry)return
    pending.delete(message.id)
    if(message.error)entry.reject(Error('Worker profiler: '+message.error.message))
    else entry.resolve(message.result)
  }
  const detached=event=>{if(event.sessionId===sessionId)close()}
  browserSession.on('Target.receivedMessageFromTarget',receive)
  browserSession.on('Target.detachedFromTarget',detached)
  return {
    async send(method,params){
      if(closed)throw Error('Worker profiler session detached')
      const id=++next
      const response=new Promise((resolve,reject)=>pending.set(id,{resolve,reject}))
      // Keep transport and remote-command failures in one returned promise.
      void response.catch(()=>{})
      try{await browserSession.send('Target.sendMessageToTarget',{
        sessionId,message:JSON.stringify({id,method,...(params===undefined?{}:{params})}),
      })}catch(error){pending.get(id)?.reject(error);pending.delete(id)}
      return response
    },
    async detach(){
      try{if(!closed)await browserSession.send('Target.detachFromTarget',{sessionId})}
      finally{
        close()
        browserSession.off('Target.receivedMessageFromTarget',receive)
        browserSession.off('Target.detachedFromTarget',detached)
      }
    },
  }
}

export function boundedNativeWorkerCPUProfile(session,{
  maxDurationMs=20000,maxBytes=8*1024*1024,samplingIntervalUs=5000,requestTimeoutMs=5000,
  writeProfile,now=()=>performance.now(),setTimer=setTimeout,clearTimer=clearTimeout,
}={}){
  for(const [value,limit]of [[maxDurationMs,60000],[maxBytes,64*1024*1024],[samplingIntervalUs,100000],[requestTimeoutMs,10000]])
    assert.ok(Number.isSafeInteger(value)&&value>0&&value<=limit,'Invalid worker profile limit')
  assert.equal(typeof writeProfile,'function','Worker profile requires an output sink')
  let starting,stopping,recordTimer,stopReason
  const result={started:false,complete:false,bytes:0,maxBytes,maxDurationMs,samplingIntervalUs,errors:[]}
  const fail=(phase,error)=>result.errors.push({phase,error:String(error)})
  const deadline=async(operation,phase)=>{
    let timer
    try{return await Promise.race([operation,new Promise((_,reject)=>{
      timer=setTimer(()=>reject(Error('Worker profile request timed out: '+phase)),requestTimeoutMs)
    })])}finally{clearTimer(timer)}
  }
  const send=(method,params)=>deadline(Promise.resolve().then(()=>session.send(method,params)),method)
  const start=()=>{
    if(stopping)return Promise.resolve(result)
    return starting??=(async()=>{
      result.started=true;result.startedAtMs=now()
      recordTimer=setTimer(()=>{void stop('duration-limit')},maxDurationMs)
      try{
        await send('Profiler.enable')
        await send('Profiler.setSamplingInterval',{interval:samplingIntervalUs})
        await send('Profiler.start')
      }catch(error){fail('start',error)}
      return result
    })()
  }
  const stop=reason=>{
    stopReason??=reason
    return stopping??=(async()=>{
      try{
        if(!starting){result.stopReason='not-started';return result}
        await starting;clearTimer(recordTimer)
        result.stopReason=stopReason;result.stoppedAtMs=now()
        const {profile}=await send('Profiler.stop')
        assert.ok(profile&&Array.isArray(profile.nodes),'Worker CPU profile missing')
        const bytes=Buffer.from(JSON.stringify(profile)+'\n')
        if(bytes.length>maxBytes)throw Error('Worker CPU profile exceeds byte limit')
        await writeProfile(bytes);result.bytes=bytes.length;result.complete=result.errors.length===0
      }catch(error){fail('stop',error)}
      finally{
        clearTimer(recordTimer)
        if(starting)try{await send('Profiler.disable')}catch(error){fail('disable',error);result.complete=false}
        try{await deadline(Promise.resolve().then(()=>session.detach()),'detach')}
        catch(error){fail('detach',error);result.complete=false}
      }
      return result
    })()
  }
  return {start,stop,snapshot:()=>({...result,errors:result.errors.map(row=>({...row}))})}
}
