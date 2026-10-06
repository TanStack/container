import assert from 'node:assert/strict'

// Node-side Chromium diagnostics only. No guest promises, modules or requests
// are wrapped. A trace failure is returned separately from workload failure.
export function boundedNativeCPUTrace(session,{
  maxDurationMs=20000,maxBytes=8*1024*1024,requestTimeoutMs=5000,
  writeChunk,now=()=>performance.now(),setTimer=setTimeout,clearTimer=clearTimeout,
}={}){
  for(const [value,limit]of [[maxDurationMs,60000],[maxBytes,64*1024*1024],[requestTimeoutMs,10000]])
    assert.ok(Number.isSafeInteger(value)&&value>0&&value<=limit,'Invalid CPU trace limit')
  assert.equal(typeof writeChunk,'function','CPU trace requires a bounded output sink')
  const result={started:false,complete:false,bytes:0,maxBytes,maxDurationMs,errors:[]}
  let starting,stopping,recordTimer,stopReason
  const fail=(phase,error)=>{result.errors.push({phase,error:String(error)})}
  const deadline=async(operation,phase)=>{
    let timer
    try{return await Promise.race([operation,new Promise((_,reject)=>{
      timer=setTimer(()=>reject(Error('CPU trace request timed out: '+phase)),requestTimeoutMs)
    })])}finally{clearTimer(timer)}
  }
  const send=(method,params)=>deadline(Promise.resolve().then(()=>session.send(method,params)),method)
  const start=()=>{
    if(stopping)return Promise.resolve(result)
    return starting??=(async()=>{
      result.started=true;result.startedAtMs=now()
      recordTimer=setTimer(()=>{void stop('duration-limit')},maxDurationMs)
      try{
        await send('Tracing.start',{
          categories:'-*,disabled-by-default-v8.cpu_profiler',
          options:'record-as-much-as-possible',transferMode:'ReturnAsStream',
        })
      }catch(error){fail('start',error)}
      return result
    })()
  }
  const stop=reason=>{
    stopReason??=reason
    return stopping??=(async()=>{
      let stream,completionListener,completionTimer
      try{
        if(!starting){result.stopReason='not-started';return result}
        await starting
        clearTimer(recordTimer)
        result.stopReason=stopReason;result.stoppedAtMs=now()
        const completed=new Promise((resolve,reject)=>{
          completionListener=resolve
          session.once('Tracing.tracingComplete',completionListener)
          completionTimer=setTimer(()=>reject(Error('CPU trace completion timed out')),requestTimeoutMs)
        })
        // Register the completion before ending. Keep a rejection handler while
        // waiting for the command response, which may itself fail.
        void completed.catch(()=>{})
        await send('Tracing.end')
        const completion=await completed
        clearTimer(completionTimer)
        stream=completion.stream
        assert.ok(typeof stream==='string'&&stream.length,'CPU trace stream missing')
        for(;;){
          const chunk=await send('IO.read',{handle:stream,size:65536})
          const bytes=Buffer.from(chunk.data,chunk.base64Encoded?'base64':'utf8')
          if(result.bytes+bytes.length>maxBytes)throw Error('CPU trace exceeds byte limit')
          await writeChunk(bytes);result.bytes+=bytes.length
          if(chunk.eof){result.complete=result.errors.length===0;break}
        }
      }catch(error){fail('stop',error)}
      finally{
        clearTimer(recordTimer);clearTimer(completionTimer)
        if(completionListener)session.off('Tracing.tracingComplete',completionListener)
        if(stream)try{await send('IO.close',{handle:stream})}catch(error){fail('close',error);result.complete=false}
        try{await deadline(Promise.resolve().then(()=>session.detach()),'detach')}
        catch(error){fail('detach',error);result.complete=false}
      }
      return result
    })()
  }
  return {start,stop,snapshot:()=>({...result,errors:result.errors.map(row=>({...row}))})}
}
