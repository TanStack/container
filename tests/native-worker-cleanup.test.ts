import {afterEach,expect,it,vi} from 'vitest'

const state=vi.hoisted(()=>({workers:[] as any[],fileCloses:0,portCloses:0,watchCloses:0,portOpens:0,portStops:0}))
vi.mock('../src/vite-browser/node-fs',()=>({vol:{},readVolume:()=>({}),getNativeSyncFileClient:()=>undefined}))
vi.mock('../src/native/worker-network',()=>({forwardWorkerPort:()=>{
  state.portOpens++
  return ()=>state.portStops++
}}))
vi.mock('../src/vite-browser/runtime-network',()=>({network:{}}))
vi.mock('../src/native/workspace-events',()=>({observeWorkspaceEvents:()=>({close:()=>state.watchCloses++})}))
vi.mock('../src/native/sync-file-bridge',()=>({createNativeSyncFileLane:()=>({}),NativeSyncFileHost:class{
  files={changedPaths:new Set()};close(){state.fileCloses++}
}}))
vi.mock('../src/native/sync-port-bridge',()=>({createNativeSyncPortLane:()=>({}),NativeSyncPortHost:class{
  owns(){return false} close(){state.portCloses++}
}}))
import {Worker,disposeNativeWorkers,enterNativeThread,receiveNativeThreadMessage,parentPort,receiveMessageOnPort} from '../src/native/worker-threads'
import {beginNodeCommandTimerActivity} from '../src/vite-browser/node-timers'
import browserProcess from 'process/browser'

function setup(){
  state.workers=[];state.fileCloses=0;state.portCloses=0;state.watchCloses=0;state.portOpens=0;state.portStops=0
  vi.stubGlobal('self',{location:{href:'https://sandbox.test/runtime.js'},postMessage:vi.fn()})
  vi.stubGlobal('MessageChannel',class{port1={};port2={}})
  vi.stubGlobal('Worker',class{
    onmessage:any;onerror:any;onmessageerror:any;terminated=0;sent:any[]=[]
    constructor(){state.workers.push(this)}
    postMessage(...args:any[]){this.sent.push(args)} terminate(){this.terminated++}
  })
}
afterEach(async()=>{await disposeNativeWorkers();vi.unstubAllGlobals()})

it('settles pending command stdin when terminated before startup',async()=>{
  setup()
  const worker=new Worker('/app/child.js',{command:true})
  const pending=expect(worker.writeInput(new Uint8Array([1]))).rejects.toMatchObject({code:'EPIPE'})
  await worker.terminate()
  await pending
})

it('sends command input one chunk at a time after startup',async()=>{
  setup()
  const worker=new Worker('/app/child.js',{command:true})
  const first=worker.writeInput(new Uint8Array([1])),second=worker.writeInput(new Uint8Array([2]))
  const host=state.workers[0]
  host.onmessage({data:{type:'native-thread-ready'}})
  const messages=()=>host.sent.map(([message]:any[])=>message).filter((message:any)=>message.type==='native-thread-input')
  expect(messages()).toHaveLength(1)
  host.onmessage({data:{type:'native-thread-input-ack',inputId:messages()[0].inputId}})
  await first
  expect(messages()).toHaveLength(2)
  host.onmessage({data:{type:'native-thread-input-ack',inputId:messages()[1].inputId}})
  await second
})

it('acknowledges worker output only after a captured stream consumes its buffer',async()=>{
  setup()
  const worker=new Worker('/app/child.js',{stdout:true})
  const host=state.workers[0]
  host.onmessage({data:{type:'native-thread-output',stream:'stdout',bytes:new Uint8Array(65536),outputId:7}})
  expect(host.sent.some(([message]:any[])=>message.type==='native-thread-output-ack')).toBe(false)
  worker.stdout.resume()
  await new Promise(resolve=>setTimeout(resolve,0))
  expect(host.sent.filter(([message]:any[])=>message.type==='native-thread-output-ack').map(([message]:any[])=>message.outputId)).toEqual([7])
})

it('captured worker output streams deliver bytes and end on exit',async()=>{
  setup()
  const worker=new Worker('/app/child.js',{stdout:true,stderr:true})
  let stdout='',stderr=''
  worker.stdout.on('data',(chunk:any)=>{stdout+=String(chunk)})
  worker.stderr.on('data',(chunk:any)=>{stderr+=String(chunk)})
  const ended=Promise.all([new Promise(resolve=>worker.stdout.once('end',resolve)),
    new Promise(resolve=>worker.stderr.once('end',resolve))])
  state.workers[0].onmessage({data:{type:'native-thread-output',stream:'stdout',text:'hello'}})
  state.workers[0].onmessage({data:{type:'native-thread-output',stream:'stderr',text:'warning'}})
  state.workers[0].onmessage({data:{type:'native-thread-exit',code:0}})
  await ended
  expect(stdout).toBe('hello')
  expect(stderr).toBe('warning')
})

it('worker output preserves non-UTF8 bytes without decoding',()=>{
  setup()
  const worker=new Worker('/app/child.js',{stdout:true})
  const bytes:number[]=[]
  worker.stdout.on('data',(chunk:any)=>bytes.push(...chunk))
  state.workers[0].onmessage({data:{type:'native-thread-output',stream:'stdout',bytes:new Uint8Array([0xff,0,0xf0])}})
  state.workers[0].onmessage({data:{type:'native-thread-output',stream:'stdout',bytes:new Uint8Array([0x9f,0x98,0x80])}})
  expect(bytes).toEqual([0xff,0,0xf0,0x9f,0x98,0x80])
})

it('captures parent cwd when constructing a worker',()=>{
  setup()
  const original=browserProcess.cwd
  browserProcess.cwd=()=>'/tmp/task'
  try{
    new Worker('/app/child.js')
    browserProcess.cwd=()=>'/app'
    state.workers[0].onmessage({data:{type:'native-thread-bootstrap-ready'}})
    expect(state.workers[0].sent[0][0].cwd).toBe('/tmp/task')
  }finally{browserProcess.cwd=original}
})

it('copies the parent environment at construction and respects explicit replacement',()=>{
  setup()
  const previous=browserProcess.env.NATIVE_ENV_PROBE
  try{
    browserProcess.env.NATIVE_ENV_PROBE='parent'
    new Worker('/app/child.js')
    browserProcess.env.NATIVE_ENV_PROBE='changed'
    state.workers[0].onmessage({data:{type:'native-thread-bootstrap-ready'}})
    expect(state.workers[0].sent[0][0].env.NATIVE_ENV_PROBE).toBe('parent')
    const replacement={ONLY:'explicit'}
    new Worker('/app/child.js',{env:replacement})
    replacement.ONLY='changed'
    state.workers[1].onmessage({data:{type:'native-thread-bootstrap-ready'}})
    expect(state.workers[1].sent[0][0].env).toEqual({ONLY:'explicit'})
  }finally{
    if(previous===undefined)delete browserProcess.env.NATIVE_ENV_PROBE
    else browserProcess.env.NATIVE_ENV_PROBE=previous
  }
})

it('forwards descendant progress with its worker identity without changing process output',()=>{
  setup()
  const worker=new Worker('/app/child.js')
  const stdout=vi.fn();worker.on('stdout',stdout)
  state.workers[0].onmessage({data:{type:'native-dev-progress',phase:'module-loading'}})
  expect(worker.phase).toBe('module-loading')
  expect(self.postMessage).toHaveBeenCalledWith({type:'native-dev-progress',phase:`worker:${worker.threadId}:module-loading`})
  expect(stdout).not.toHaveBeenCalled()
})

it('reports synchronous port reads as unsupported rather than pretending the queue is empty',()=>{
  expect(()=>receiveMessageOnPort({})).toThrow(expect.objectContaining({code:'ERR_UNSUPPORTED_OPERATION'}))
})

it('referenced workers keep their owner alive until unref or termination',async()=>{
  setup()
  const activity=beginNodeCommandTimerActivity()
  try{
    const worker=new Worker('/app/child.js')
    let idle=false
    const firstIdle=activity.waitForIdle().then(()=>{idle=true})
    await Promise.resolve();expect(idle).toBe(false)
    expect(worker.unref()).toBeUndefined()
    await firstIdle;expect(idle).toBe(true)
    expect(worker.ref()).toBeUndefined()
    idle=false
    const secondIdle=activity.waitForIdle().then(()=>{idle=true})
    await Promise.resolve();expect(idle).toBe(false)
    await worker.terminate()
    await secondIdle;expect(idle).toBe(true)
  }finally{activity.stop()}
})

it('parent port once listeners release activity, including after removeAllListeners',async()=>{
  setup()
  const activity=beginNodeCommandTimerActivity()
  try{
    enterNativeThread(undefined)
    expect(parentPort!.hasRef()).toBe(false)
    parentPort!.on('message',()=>{})
    expect(parentPort!.hasRef()).toBe(true)
    parentPort!.removeAllListeners()
    expect(parentPort!.hasRef()).toBe(false)
    parentPort!.once('message',()=>expect(parentPort!.hasRef()).toBe(false))
    receiveNativeThreadMessage(42)
    await Promise.resolve()
    expect(parentPort!.hasRef()).toBe(false)
    await activity.waitForIdle()
  }finally{parentPort!.close();activity.stop()}
})

it('parent port close notifies once before its owner finishes waiting for idle',async()=>{
  setup()
  const activity=beginNodeCommandTimerActivity(),events:string[]=[]
  try{
    enterNativeThread(undefined)
    parentPort!.on('message',()=>{})
    parentPort!.on('close',()=>events.push('close'))
    const idle=activity.waitForIdle().then(()=>events.push('idle'))
    parentPort!.close();parentPort!.close()
    events.push('returned')
    expect(events).toEqual(['returned'])
    await idle
    expect(events).toEqual(['returned','close','idle'])
  }finally{activity.stop()}
})

it('releases command lanes and emits exit even when an error listener throws',()=>{
  setup()
  const worker=new Worker('/app/child.js',{command:true})
  const exit=vi.fn()
  worker.on('exit',exit)
  worker.on('error',()=>{throw Error('Listener failed')})
  expect(()=>state.workers[0].onerror({message:'Worker failed'})).toThrow('Listener failed')
  expect(exit).toHaveBeenCalledExactlyOnceWith(1)
  expect(state.fileCloses).toBe(1)
  expect(state.portCloses).toBe(1)
  expect(state.watchCloses).toBe(1)
  expect(state.workers[0].terminated).toBe(1)
})

it('owner shutdown releases every worker without invoking guest exit listeners',async()=>{
  setup()
  const first=new Worker('/app/first.js')
  const second=new Worker('/app/second.js')
  first.on('exit',()=>{throw Error('Exit listener failed')})
  const exit=vi.fn();second.on('exit',exit)
  await expect(disposeNativeWorkers()).resolves.toBeUndefined()
  expect(state.workers.map(worker=>worker.terminated)).toEqual([1,1])
  expect(state.fileCloses).toBe(2)
  expect(state.portCloses).toBe(2)
  expect(exit).not.toHaveBeenCalled()
  await expect(disposeNativeWorkers()).resolves.toBeUndefined()
})

it('ignores late exit messages after termination',async()=>{
  setup()
  const worker=new Worker('/app/child.js')
  const exit=vi.fn();worker.on('exit',exit)
  await worker.terminate()
  state.workers[0].onmessage({data:{type:'native-thread-exit',code:7}})
  expect(exit).toHaveBeenCalledExactlyOnceWith(0)
  expect(state.fileCloses).toBe(1)
})

it.each(['terminate','exit','error'] as const)('ignores all late worker messages after %s',async ending=>{
  setup()
  const worker=new Worker('/app/child.js',{command:true}),raw=state.workers[0]
  const events:string[]=[]
  for(const name of ['online','message','input-demand','disconnect','stdout','stderr','stdout-bytes','error','exit'])
    worker.on(name,()=>events.push(name))
  if(ending==='terminate')await worker.terminate()
  else if(ending==='exit')raw.onmessage({data:{type:'native-thread-exit',code:0}})
  else raw.onerror({message:'Startup failed'})
  events.length=0
  const sent=raw.sent.length
  for(const data of [
    {type:'native-thread-bootstrap-ready'},
    {type:'native-thread-ready'},
    {type:'native-dev-progress',phase:'rolldown-loaded'},
    {type:'native-thread-message',value:'retired'},
    {type:'native-thread-input-demand'},
    {type:'native-thread-disconnect'},
    {type:'native-thread-output',stream:'stdout',text:'retired'},
    {type:'native-thread-output',stream:'stderr',text:'retired'},
    {type:'native-thread-output',stream:'stdout',bytes:new Uint8Array([1]),outputId:1},
    {type:'native-thread-port',event:{type:'open',port:4501}},
    {type:'native-thread-port',event:{type:'close',port:4501}},
    {type:'native-thread-error',error:'Retired error'},
    {type:'native-thread-exit',code:1},
  ])raw.onmessage({data})
  expect({events,extraPosts:raw.sent.length-sent,progress:vi.mocked(self.postMessage).mock.calls,
    portOpens:state.portOpens,portStops:state.portStops,fileCloses:state.fileCloses,
    portCloses:state.portCloses,watchCloses:state.watchCloses,terminated:raw.terminated}).toEqual({
    events:[],extraPosts:0,progress:[],portOpens:0,portStops:0,fileCloses:1,
    portCloses:1,watchCloses:1,terminated:1,
  })
})

it('terminates an online worker asynchronously with the same result for concurrent callers',async()=>{
  setup()
  const worker=new Worker('/app/child.js'),events:number[]=[]
  state.workers[0].onmessage({data:{type:'native-thread-ready'}})
  worker.on('exit',code=>events.push(code))
  const first=worker.terminate(),second=worker.terminate()
  expect(events).toEqual([])
  expect(await first).toBe(1)
  expect(await second).toBe(1)
  expect(events).toEqual([1])
  expect(await worker.terminate()).toBeUndefined()
  expect(state.workers[0].terminated).toBe(1)
})

it('termination after natural exit does not invent a new exit result',async()=>{
  setup()
  const worker=new Worker('/app/child.js')
  state.workers[0].onmessage({data:{type:'native-thread-exit',code:7}})
  expect(await worker.terminate()).toBeUndefined()
})

it('ignores messages after exit without cloning or detaching their transfers',async()=>{
  setup()
  const worker=new Worker('/app/child.js')
  state.workers[0].onmessage({data:{type:'native-thread-exit',code:0}})
  const bytes=new Uint8Array([1,2])
  expect(worker.postMessage({bytes},[bytes.buffer])).toBeUndefined()
  expect([...bytes]).toEqual([1,2])
  expect(worker.postMessage(()=>{})).toBeUndefined()
})

it('queued transfers detach immediately and preserve the posted snapshot before startup',()=>{
  setup()
  const worker=new Worker('/app/child.js')
  const bytes=new Uint8Array([1,2,3]),message={bytes,label:'posted'}
  worker.postMessage(message,[bytes.buffer])
  expect(bytes.byteLength).toBe(0)
  message.label='mutated later'
  const raw=state.workers[0]
  raw.onmessage({data:{type:'native-thread-ready'}})
  const [posted,transfers]=raw.sent.at(-1)
  expect(posted.value.label).toBe('posted')
  expect([...posted.value.bytes]).toEqual([1,2,3])
  expect(transfers[0]).toBe(posted.value.bytes.buffer)
})

it('buffers incoming parent messages until the guest listener starts and keeps their order',async()=>{
  setup();enterNativeThread(undefined)
  receiveNativeThreadMessage(1)
  const received:number[]=[]
  parentPort!.on('message',value=>received.push(value))
  receiveNativeThreadMessage(2)
  expect(received).toEqual([])
  await Promise.resolve()
  receiveNativeThreadMessage(3)
  expect(received).toEqual([1,2,3])
  parentPort!.close()
  receiveNativeThreadMessage(4)
  expect(received).toEqual([1,2,3])
})

it('snapshots workerData and transfers its buffers during construction',()=>{
  setup()
  const bytes=new Uint8Array([8,9]),data={bytes,label:'initial'}
  new Worker('/app/child.js',{workerData:data,transferList:[bytes.buffer]})
  expect(bytes.byteLength).toBe(0)
  data.label='changed'
  const raw=state.workers[0]
  raw.onmessage({data:{type:'native-thread-bootstrap-ready'}})
  const [startup,transfers]=raw.sent[0]
  expect(startup.workerData.label).toBe('initial')
  expect([...startup.workerData.bytes]).toEqual([8,9])
  expect(transfers.at(-1)).toBe(startup.workerData.bytes.buffer)
})

it('rejects uncloneable workerData before allocating worker resources',()=>{
  setup()
  expect(()=>new Worker('/app/child.js',{workerData:()=>{}})).toThrow()
  expect(state.workers).toHaveLength(0)
  expect(state.fileCloses).toBe(0)
})
