import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {boundedNativeCPUTrace} from '../scripts/native-cpu-trace.mjs'

class Session extends EventEmitter{
  calls=[];chunks=[{data:'{"traceEvents":[]}',eof:true}];detached=0;failures={}
  async send(method,params){
    this.calls.push({method,params})
    if(this.failures[method])throw this.failures[method]
    if(method==='Tracing.end')queueMicrotask(()=>this.emit('Tracing.tracingComplete',{stream:'trace'}))
    if(method==='IO.read')return this.chunks.shift()
    return {}
  }
  async detach(){this.detached++;if(this.failures.detach)throw this.failures.detach}
}
const setup=options=>{
  const session=new Session(),chunks=[]
  const trace=boundedNativeCPUTrace(session,{writeChunk:bytes=>chunks.push(bytes),...options})
  return {session,chunks,trace}
}

test('captures only CPU samples and drains a complete bounded stream once',async()=>{
  const {session,chunks,trace}=setup()
  await trace.start();await trace.start()
  const stopped=trace.stop('first-request-ready')
  assert.equal(trace.stop('cleanup'),stopped)
  const result=await stopped
  assert.equal(result.complete,true);assert.equal(result.stopReason,'first-request-ready')
  assert.equal(result.bytes,Buffer.concat(chunks).length)
  assert.deepEqual(JSON.parse(Buffer.concat(chunks)),{traceEvents:[]})
  assert.equal(session.calls[0].params.categories,'-*,disabled-by-default-v8.cpu_profiler')
  for(const method of ['Tracing.start','Tracing.end','IO.close'])assert.equal(session.calls.filter(row=>row.method===method).length,1)
  assert.equal(session.detached,1);assert.equal(session.listenerCount('Tracing.tracingComplete'),0)
})

test('reports byte overflow without truncating a chunk or claiming completeness',async()=>{
  const {session,chunks,trace}=setup({maxBytes:3})
  await trace.start();const result=await trace.stop('ready')
  assert.equal(result.complete,false);assert.equal(result.bytes,0);assert.deepEqual(chunks,[])
  assert.match(result.errors[0].error,/exceeds byte limit/)
  assert.ok(session.calls.some(row=>row.method==='IO.close'));assert.equal(session.detached,1)
})

test('supports base64 chunks and retains detached snapshots',async()=>{
  const {session,chunks,trace}=setup()
  session.chunks=[{data:Buffer.from('hello').toString('base64'),base64Encoded:true,eof:true}]
  await trace.start();await trace.stop('ready')
  assert.equal(Buffer.concat(chunks).toString(),'hello')
  const snapshot=trace.snapshot();snapshot.errors.push({phase:'fake'})
  assert.deepEqual(trace.snapshot().errors,[])
})

test('duration cap stops recording without waiting for workload cleanup',async()=>{
  const timers=new Set(),{session,trace}=setup({
    setTimer:(callback,ms)=>{const timer={callback,ms};timers.add(timer);return timer},
    clearTimer:timer=>timers.delete(timer),
  })
  await trace.start()
  const timer=[...timers].find(timer=>timer.ms===20000);assert.ok(timer)
  timer.callback()
  const result=await trace.stop('cleanup')
  assert.equal(result.stopReason,'duration-limit');assert.equal(result.complete,true)
  assert.equal(timers.size,0);assert.equal(session.detached,1)
})

test('stop during startup still ends the trace after startup settles',async()=>{
  const {session,trace}=setup();let release
  const send=session.send.bind(session)
  session.send=async(method,params)=>{if(method==='Tracing.start')await new Promise(resolve=>{release=resolve});return send(method,params)}
  const started=trace.start();await new Promise(resolve=>setImmediate(resolve))
  const stopped=trace.stop('ready');release();await started
  assert.equal((await stopped).complete,true)
  assert.deepEqual(session.calls.map(row=>row.method),['Tracing.start','Tracing.end','IO.read','IO.close'])
})

test('transport, output and cleanup failures remain separate diagnostic errors',async()=>{
  for(const method of ['Tracing.start','Tracing.end','IO.read','IO.close','detach','sink']){
    const failure=Error(method+' failed'),{session,trace}=setup(method==='sink'?{writeChunk:()=>{throw failure}}:{})
    if(method!=='sink')session.failures[method]=failure
    await trace.start();const result=await trace.stop('ready')
    assert.equal(result.complete,false,method)
    assert.ok(result.errors.some(row=>row.error.includes(failure.message)),method)
    assert.equal(session.detached,1,method)
  }
})

test('cleanup before the trigger does not start a trace',async()=>{
  const {session,trace}=setup()
  assert.equal((await trace.stop('cleanup')).stopReason,'not-started')
  await trace.start()
  assert.deepEqual(session.calls,[]);assert.equal(session.detached,1)
})

test('completion and read timeouts are diagnostic failures with cleanup',async()=>{
  for(const hanging of ['completion','IO.read']){
    const timers=new Set(),{session,trace}=setup({
      setTimer:(callback,ms)=>{const timer={callback,ms};timers.add(timer);return timer},
      clearTimer:timer=>timers.delete(timer),
    })
    const send=session.send.bind(session)
    session.send=(method,params)=>hanging==='completion'&&method==='Tracing.end'?Promise.resolve({}):
      hanging===method?new Promise(()=>{}):send(method,params)
    await trace.start();const stopped=trace.stop('ready')
    await new Promise(resolve=>setImmediate(resolve))
    const timer=[...timers].find(timer=>timer.ms===5000);assert.ok(timer)
    timer.callback()
    const result=await stopped
    assert.equal(result.complete,false);assert.match(result.errors[0].error,/timed out/)
    assert.equal(session.detached,1);assert.equal(timers.size,0)
  }
})

test('validates explicit diagnostic limits',()=>{
  for(const field of ['maxDurationMs','maxBytes','requestTimeoutMs'])for(const value of [0,-1,1.5,Infinity,null])
    assert.throws(()=>setup({[field]:value}))
  assert.throws(()=>boundedNativeCPUTrace(new Session()))
})
