import assert from 'node:assert/strict'

// Format already-returned test metadata on the Node side. This does not observe
// or wrap a guest operation, promise, worker or network response.
export function nativeOwnerTimingRecord({browser,example,result}){
  assert.ok(['chromium','firefox','webkit'].includes(browser),'Unknown timing browser')
  assert.ok(typeof example==='string'&&example.length>0,'Missing timing example')
  const duration=value=>{
    assert.ok(Number.isFinite(value)&&value>=0,'Invalid timing duration')
    return value
  }
  assert.ok(result?.timings&&typeof result.timings==='object','Missing returned timings')
  duration(result.timings.startMs)
  const timings=Object.fromEntries(Object.entries(result.timings).map(([name,value])=>[name,duration(value)]))
  assert.ok(Array.isArray(result.startupStages),'Missing returned startup stages')
  const startupStages=result.startupStages.map(({phase,elapsedMs})=>{
    assert.ok(typeof phase==='string'&&phase.length>0,'Invalid startup phase')
    // Relayed child-worker phases do not always carry a worker timestamp.
    // Keep the phase and leave its time unknown, never invent or clamp a value.
    return elapsedMs===undefined?{phase}:{phase,elapsedMs:duration(elapsedMs)}
  })
  const record={browser,example,timings,startupStages}
  if(result.production){
    const {checkpointBytes,checkpointChunks,restoreMs,restoreTimes}=result.production
    for(const value of [checkpointBytes,checkpointChunks])assert.ok(Number.isSafeInteger(value)&&value>=0,'Invalid checkpoint count')
    assert.ok(Array.isArray(restoreTimes),'Missing restore timings')
    Object.assign(record,{checkpointBytes,checkpointChunks,restoreMs:duration(restoreMs),restoreTimes:restoreTimes.map(duration)})
  }
  return record
}

export function writeNativeOwnerTimings({enabled,write=console.log,...input}){
  if(enabled)write(JSON.stringify(nativeOwnerTimingRecord(input)))
}
