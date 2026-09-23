import {test,expect} from 'vitest'
import {GuestProcesses,InputPipe,type ProcessInput} from '../src/sandbox/guest-processes'
const input:ProcessInput={code:'',argv:[],options:{}}
const result={exitCode:0,stdout:'',stderr:'',duration:0,wasmHeapBytes:0}

test('output pipe backpressure bounds queued bytes and resumes on consumption',async()=>{
  const processes=new GuestProcesses(record=>new Promise(resolve=>record.controller.signal.addEventListener('abort',()=>resolve(result))))
  const child=processes.start(0,input)
  for(let i=0;i<16;i++)await processes.writeOutput(child,{type:'stdout',bytes:new Uint8Array(65536)})
  let completed=false
  const writing=processes.writeOutput(child,{type:'stdout',bytes:new Uint8Array([42])}).then(()=>completed=true)
  await Promise.resolve();expect(completed).toBe(false);expect(child.queuedBytes).toBe(1048576)
  expect(()=>processes.writeOutput(child,{type:'stdout',bytes:new Uint8Array([1])})).toThrow('already pending')
  await processes.next(0,child.pid);await writing
  expect(child.queuedBytes).toBe(1048576-65536+1)
  processes.kill(0,child.pid);await child.result
})
test('canceling an unread output pipe rejects its pending writer',async()=>{
  const processes=new GuestProcesses(record=>new Promise(resolve=>record.controller.signal.addEventListener('abort',()=>resolve(result))))
  const child=processes.start(0,input)
  for(let i=0;i<16;i++)await processes.writeOutput(child,{type:'stdout',bytes:new Uint8Array(65536)})
  const writing=processes.writeOutput(child,{type:'stdout',bytes:new Uint8Array([1])})
  const rejected=expect(writing).rejects.toThrow('Process output is closed')
  processes.kill(0,child.pid);await rejected;await child.result
  expect(child.pendingOutput).toEqual([])
})

test('partial input reads retain tails and serve waiting inherited readers in order',async()=>{
  const pipe=new InputPipe()
  const a=pipe.read(1,2),b=pipe.read(2,1)
  await pipe.write(new Uint8Array([1,2,3,4,5]))
  expect(await a).toEqual(new Uint8Array([1,2]));expect(await b).toEqual(new Uint8Array([3]))
  expect(await pipe.read(1,0)).toEqual(new Uint8Array())
  pipe.end()
  expect(await pipe.read(1,1)).toEqual(new Uint8Array([4]))
  expect(await pipe.read(1,8)).toEqual(new Uint8Array([5]))
  expect(await pipe.read(1,1)).toBe(null)
  expect(()=>pipe.read(1,-1)).toThrow('Invalid stdin')
})

test('stdin copies bytes, applies backpressure and drains before EOF',async()=>{
  const pipe=new InputPipe(),bytes=new Uint8Array(65536).fill(7)
  await pipe.write(bytes);bytes.fill(9)
  let completed=false
  const writing=pipe.write(new Uint8Array([3])).then(()=>completed=true)
  await Promise.resolve();expect(completed).toBe(false)
  expect(()=>pipe.end()).toThrow('Wait for pending stdin writes')
  expect((await pipe.read())?.[0]).toBe(7)
  await writing;pipe.end()
  expect(await pipe.read()).toEqual(new Uint8Array([3]));expect(await pipe.read()).toBe(null)
  expect(()=>pipe.write(bytes)).toThrow('EPIPE')
})
test('stdin closes pending writers and readers',async()=>{
  const pipe=new InputPipe();await pipe.write(new Uint8Array(65536))
  const writing=pipe.write(new Uint8Array([1]));const rejected=expect(writing).rejects.toThrow('EPIPE');pipe.close();await rejected
  const other=new InputPipe(),reading=other.read();expect(()=>other.read()).toThrow('already pending');other.close();expect(await reading).toBe(null)
})
test('process ownership, completion and event ordering',async()=>{
  const processes=new GuestProcesses(async record=>{processes.emit(record,{type:'stdout',bytes:new Uint8Array([42])});return result})
  const child=processes.start(12,input)
  expect(()=>processes.get(13,child.pid)).toThrow('unavailable')
  await child.result
  expect(await processes.next(12,child.pid)).toEqual({type:'stdout',bytes:new Uint8Array([42])})
  expect(await processes.next(12,child.pid)).toEqual({type:'exit',code:0,signal:null})
  expect(await processes.next(12,child.pid)).toBe(null)
  processes.forget(12,child.pid);expect(()=>processes.get(12,child.pid)).toThrow('unavailable')
})
test('process size reports retained records until the owner forgets them',async()=>{
  const processes=new GuestProcesses(async()=>result)
  const child=processes.start(0,input)
  expect(processes.size).toBe(1);expect(processes.active).toHaveLength(1)
  await child.result
  expect(processes.size).toBe(1);expect(processes.active).toHaveLength(0)
  processes.forget(0,child.pid)
  expect(processes.size).toBe(0)
})
test('completed retained records release their memory reservation before forgetting',async()=>{
  const finish=new Map<number,()=>void>()
  const processes=new GuestProcesses(record=>new Promise(resolve=>finish.set(record.pid,()=>resolve(result))))
  const options={...input,options:{maxBytes:128*1024*1024}}
  const first=processes.start(0,options),second=processes.start(0,options)
  await Promise.resolve()
  const reserved=()=>processes.active.reduce((bytes,record)=>bytes+record.input.options.maxBytes!,0)
  expect(reserved()).toBe(256*1024*1024)
  finish.get(first.pid)!();await first.result
  expect(processes.size).toBe(2)
  expect(reserved()).toBe(128*1024*1024)
  const replacement=processes.start(0,options)
  await Promise.resolve()
  expect(processes.size).toBe(3)
  expect(reserved()).toBe(256*1024*1024)
  finish.get(second.pid)!();finish.get(replacement.pid)!()
  await Promise.all([second.result,replacement.result])
  expect(reserved()).toBe(0)
  for(const record of [first,second,replacement])processes.forget(0,record.pid)
  expect(processes.size).toBe(0)
})
test('process cancellation releases descendants and signals waiters',async()=>{
  const processes=new GuestProcesses(record=>new Promise(resolve=>{if(record.controller.signal.aborted)resolve(result);else record.controller.signal.addEventListener('abort',()=>resolve(result))}))
  const parent=processes.start(0,input),child=processes.start(parent.pid,input)
  expect(processes.kill(0,parent.pid)).toBe(true)
  await parent.result;await child.result
  expect(child.controller.signal.aborted).toBe(true)
  expect(await processes.next(0,parent.pid)).toEqual({type:'exit',code:null,signal:'SIGTERM'})
  processes.forget(0,parent.pid)
})
test('process signals normalize Node forms, probe liveness and reject unsupported signals',async()=>{
  const processes=new GuestProcesses(record=>new Promise(resolve=>{if(record.controller.signal.aborted)resolve(result);else record.controller.signal.addEventListener('abort',()=>resolve(result))}))
  const child=processes.start(0,input)
  expect(processes.kill(0,child.pid,0)).toBe(true);expect(child.running).toBe(true);expect(child.signal).toBe(null)
  expect(()=>processes.kill(0,child.pid,'SIGUSR1')).toThrow('Unknown signal')
  expect(processes.kill(0,child.pid,'sigint')).toBe(true);await child.result
  expect(await processes.next(0,child.pid)).toEqual({type:'exit',code:null,signal:'SIGINT'})
  expect(processes.kill(0,child.pid,15)).toBe(false)
  expect(()=>processes.kill(0,child.pid,1)).toThrow('Unknown signal')
})
test('process count and aggregate memory limits reject before execution',async()=>{
  const processes=new GuestProcesses(async()=>result)
  for(let i=0;i<8;i++)processes.start(0,input)
  expect(()=>processes.start(0,input)).toThrow('Guest process limit exceeded (active=8, retained=8, reservedBytes=134217728, requestedBytes=16777216, activeLimit=8, retainedLimit=64)')
  try{processes.start(0,input)}catch(error){expect(error).toHaveProperty('code','EAGAIN')}
  const memory=new GuestProcesses(async()=>result)
  memory.start(0,{...input,options:{maxBytes:512*1024*1024}})
  expect(()=>memory.start(0,input)).toThrow('Aggregate process memory reservations exceed 512 MiB (active=1, retained=1, reservedBytes=536870912, requestedBytes=16777216, limitBytes=536870912)')
  try{memory.start(0,input)}catch(error){expect(error).toHaveProperty('code','ERR_RESOURCE_LIMIT')}
  expect(memory.size).toBe(1)
})
test('reservation diagnostics count active processes rather than completed retained records',async()=>{
  const processes=new GuestProcesses(async()=>result)
  const completed=processes.start(0,{...input,options:{maxBytes:128*1024*1024}})
  await completed.result
  const active=[processes.start(0,{...input,options:{maxBytes:128*1024*1024}})]
  for(let i=0;i<6;i++)active.push(processes.start(0,{...input,options:{maxBytes:64*1024*1024}}))
  expect(()=>processes.start(0,{...input,options:{maxBytes:64*1024*1024}})).toThrow('Aggregate process memory reservations exceed 512 MiB (active=7, retained=8, reservedBytes=536870912, requestedBytes=67108864, limitBytes=536870912)')
  expect(processes.size).toBe(8)
  await Promise.all(active.map(record=>record.result))
  const next=processes.start(0,{...input,options:{maxBytes:512*1024*1024}})
  await next.result
})
test('unread output is bounded and retains the terminal event',async()=>{
  const processes=new GuestProcesses(async record=>{
    processes.emit(record,{type:'stdout',bytes:new Uint8Array(1024*1024)})
    expect(()=>processes.emit(record,{type:'stdout',bytes:new Uint8Array([1])})).toThrow('output queue')
    return result
  })
  const child=processes.start(0,input);await child.result
  expect((await processes.next(0,child.pid))?.type).toBe('stdout')
  expect((await processes.next(0,child.pid))?.type).toBe('exit')
})

test('worker channels are owned, bidirectional and preserve lifecycle ordering',async()=>{
  const processes=new GuestProcesses(record=>new Promise(resolve=>{
    if(record.input.worker){
      expect(record.input.worker.threadId).toBe(record.pid)
      processes.emit(record,{type:'online'})
    }
    record.controller.signal.addEventListener('abort',()=>resolve(result))
  }))
  const parent=processes.start(0,input)
  const worker=processes.start(parent.pid,{...input,worker:{threadId:0,data:'encoded'},options:{stdio:'inherit'}})
  expect(()=>processes.sendWorker(0,worker.pid,new Uint8Array([1]))).toThrow('unavailable')
  expect(await processes.next(parent.pid,worker.pid)).toEqual({type:'online'})
  processes.sendWorker(parent.pid,worker.pid,new Uint8Array([1,2]))
  expect(await processes.receiveWorker(worker.pid,worker.pid)).toEqual(new Uint8Array([1,2]))
  processes.sendWorker(worker.pid,worker.pid,new Uint8Array([3,4]))
  expect(await processes.receiveWorker(parent.pid,worker.pid)).toEqual(new Uint8Array([3,4]))
  processes.kill(parent.pid,worker.pid);await worker.result
  expect(await processes.receiveWorker(parent.pid,worker.pid)).toBe(null)
  expect(await processes.next(parent.pid,worker.pid)).toEqual({type:'exit',code:null,signal:'SIGTERM'})
  processes.forget(parent.pid,worker.pid)
  processes.kill(0,parent.pid);await parent.result;processes.forget(0,parent.pid)
})

for(const drain of [true,false])test(`worker exit preserves outbound resources until ${drain?'acknowledgment':'forget'}`,async()=>{
  let finishWorker!:(value:typeof result)=>void
  const processes=new GuestProcesses(record=>new Promise(resolve=>{
    if(record.input.worker)finishWorker=resolve
    record.controller.signal.addEventListener('abort',()=>resolve(result))
  }))
  const parent=processes.start(0,input)
  const worker=processes.start(parent.pid,{...input,worker:{threadId:0,data:'encoded'}})
  await Promise.resolve()
  let released=0
  processes.sendWorker(worker.pid,worker.pid,new Uint8Array([42]),[],[{dispose(){released++}}])
  const delivery=await processes.receiveWorkerDelivery(parent.pid,worker.pid)
  expect(delivery?.bytes).toEqual(new Uint8Array([42]))
  finishWorker(result);await worker.result
  expect(released).toBe(0)
  if(drain){processes.acknowledgeWorker(parent.pid,worker.pid,delivery!.token);expect(released).toBe(1)}
  processes.forget(parent.pid,worker.pid);expect(released).toBe(1)
  processes.kill(0,parent.pid);await parent.result;processes.forget(0,parent.pid)
})

test('failed worker startup releases both module and shared resources once',async()=>{
  const processes=new GuestProcesses(async()=>{throw Error('startup failed')})
  const record=processes.start(0,input)
  let shared=0,modules=0
  record.sharedStartup={dispose(){shared++}}
  record.moduleStartup={dispose(){modules++}}
  await record.result
  expect({shared,modules}).toEqual({shared:1,modules:1})
  processes.finishWorkerData(record)
  expect({shared,modules}).toEqual({shared:1,modules:1})
})

test('closing worker port drops inbound resources but preserves accepted outbound messages',async()=>{
  const processes=new GuestProcesses(record=>new Promise(resolve=>record.controller.signal.addEventListener('abort',()=>resolve(result))))
  const parent=processes.start(0,input),worker=processes.start(parent.pid,{...input,worker:{threadId:0,data:'encoded'}})
  await Promise.resolve()
  let incoming=0,outgoing=0
  processes.sendWorker(parent.pid,worker.pid,new Uint8Array([1]),[],[{dispose(){incoming++}}])
  await processes.receiveWorkerDelivery(worker.pid,worker.pid)
  processes.sendWorker(worker.pid,worker.pid,new Uint8Array([2]),[],[{dispose(){outgoing++}}])
  processes.closeWorker(worker.pid,worker.pid)
  expect(incoming).toBe(1);expect(outgoing).toBe(0)
  const delivery=await processes.receiveWorkerDelivery(parent.pid,worker.pid)
  expect(delivery?.bytes).toEqual(new Uint8Array([2]))
  processes.acknowledgeWorker(parent.pid,worker.pid,delivery!.token)
  expect(outgoing).toBe(1)
  processes.kill(0,parent.pid);await parent.result;await worker.result
  expect(incoming).toBe(1);expect(outgoing).toBe(1)
})
