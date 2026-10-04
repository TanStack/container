import test from 'node:test'
import assert from 'node:assert/strict'
import {Worker} from 'node:worker_threads'
import {createNativeWasiThreadPool,createNativeWasiMessageHandler,instantiateNativeWasiModule} from '../src/native/wasi-thread-completion.mjs'

class FakeWorker extends EventTarget{
  messages=[]
  terminated=0
  postMessage(message){this.messages.push(message)}
  terminate(){this.terminated++}
}
function fixture(timeoutMs=0){
  const pool=createNativeWasiThreadPool({timeoutMs}),worker=pool.connect(new FakeWorker())
  const manager={unusedWorkers:[worker],pthreads:{},getNewWorker(){return this.unusedWorkers.pop()},
    cleanThread(worker,tid,force){
      delete this.pthreads[tid];delete worker.__emnapi_tid
      if(force)worker.terminate();else this.unusedWorkers.push(worker)
    }}
  pool.install(manager)
  const start=tid=>{
    const selected=manager.getNewWorker()
    assert.equal(selected,worker)
    manager.pthreads[tid]=worker;worker.__emnapi_tid=tid
    worker.postMessage({__emnapi__:{type:'start',payload:{tid,arg:0}}})
    return worker.messages.at(-1).__emnapi__.payload.nativeThreadCompletion
  }
  return {pool,worker,manager,start}
}
class FakeHandler{
  constructor(options){this.options=options}
  handle(event){this.options.onLoad?.(event.data,this.options.postMessage)}
}
const cleanup=tid=>({__emnapi__:{type:'cleanup-thread',payload:{tid}}})

test('a native completion is reusable before its cleanup message is delivered',()=>{
  const {pool,worker,manager,start}=fixture()
  try{
    const lease=start(43),sent=[]
    const handler=createNativeWasiMessageHandler(FakeHandler,{postMessage:message=>{
      assert.equal(Atomics.load(lease.state,0),1);sent.push(message)
    },onLoad:(_,send)=>send(cleanup(43))})
    handler.handle({data:worker.messages.at(-1)})
    assert.equal(manager.getNewWorker(),worker)
    assert.equal(pool.inspect().reclaims,1)
    manager.cleanThread(worker,43)
    assert.equal(manager.unusedWorkers.length,0,'Late cleanup must not insert the worker twice')
    assert.equal(sent.length,1)
  }finally{pool.dispose()}
})

test('stale cleanup cannot release a reassigned running worker',()=>{
  const {pool,worker,manager,start}=fixture()
  try{
    const first=start(43);Atomics.store(first.state,0,1)
    const second=start(44)
    assert.notEqual(first.state.buffer,second.state.buffer)
    manager.cleanThread(worker,43)
    manager.cleanThread(worker,44)
    assert.equal(manager.pthreads[44],worker)
    assert.equal(manager.unusedWorkers.length,0)
    Atomics.store(second.state,0,1);manager.cleanThread(worker,44)
    assert.equal(manager.unusedWorkers.length,1)
    manager.cleanThread(worker,44)
    assert.equal(manager.unusedWorkers.length,1)
  }finally{pool.dispose()}
})

test('native completion wakes a synchronously waiting parent through shared memory',async()=>{
  const pool=createNativeWasiThreadPool({timeoutMs:1000})
  const worker=pool.connect(new Worker(`
    const {parentPort}=require('node:worker_threads');
    parentPort.on('message',({__emnapi__:thread})=>{
      const {state,changed}=thread.payload.nativeThreadCompletion;
      Atomics.store(state,0,1);Atomics.add(changed,0,1);Atomics.notify(changed,0);
    });
  `,{eval:true}))
  const manager={unusedWorkers:[worker],pthreads:{},getNewWorker(){return this.unusedWorkers.pop()},
    cleanThread(worker,tid){delete this.pthreads[tid];delete worker.__emnapi_tid;this.unusedWorkers.push(worker)}}
  pool.install(manager)
  try{
    assert.equal(manager.getNewWorker(),worker)
    manager.pthreads[43]=worker;worker.__emnapi_tid=43
    worker.postMessage({__emnapi__:{type:'start',payload:{tid:43,arg:0}}})
    assert.equal(manager.getNewWorker(),worker)
    assert.equal(pool.inspect().allocations,1)
  }finally{pool.dispose();await worker.terminate()}
})

test('genuine capacity exhaustion is bounded and does not allocate another worker',()=>{
  const {pool,manager,start}=fixture(5)
  try{start(43);assert.equal(manager.getNewWorker(),undefined);assert.equal(pool.inspect().allocations,1)}
  finally{pool.dispose()}
})

test('failed native work is not returned to the reusable pool',()=>{
  const {pool,worker,manager,start}=fixture()
  try{
    const lease=start(43)
    const handler=createNativeWasiMessageHandler(FakeHandler,{postMessage(){},onLoad(){throw Error('native failure')}})
    assert.throws(()=>handler.handle({data:worker.messages.at(-1)}),/native failure/)
    assert.equal(Atomics.load(lease.state,0),2)
    assert.equal(manager.getNewWorker(),undefined)
    manager.cleanThread(worker,43,true)
    assert.equal(worker.terminated,1)
    assert.equal(pool.inspect().workers,0)
  }finally{pool.dispose()}
})

test('disposal closes active leases and prevents further pool operations',()=>{
  const {pool,worker,manager,start}=fixture()
  const lease=start(43)
  pool.dispose();pool.dispose()
  assert.equal(Atomics.load(lease.state,0),3)
  assert.equal(worker.terminated,1)
  assert.throws(()=>manager.getNewWorker(),/disposed/)
  assert.throws(()=>pool.connect(new FakeWorker()),/disposed/)
  assert.throws(()=>worker.postMessage({}),/closed/)
})

test('invalid pool budgets, duplicate installation and missing completion lanes fail explicitly',()=>{
  for(const timeoutMs of [-1,Infinity,30001])assert.throws(()=>createNativeWasiThreadPool({timeoutMs}),/timeout/)
  const {pool,worker,manager}=fixture()
  try{
    assert.throws(()=>pool.connect(worker),/already/)
    assert.throws(()=>pool.install(manager),/already/)
    const handler=createNativeWasiMessageHandler(FakeHandler,{postMessage(){}})
    assert.throws(()=>handler.handle({data:{__emnapi__:{type:'start',payload:{tid:43}}}}),/handoff/)
  }finally{pool.dispose()}
})

test('the adapter installs the pool before the pinned loader initializes native code',async()=>{
  let module,worker
  const result=await instantiateNativeWasiModule(options=>{
    worker=options.onCreateWorker()
    module={PThread:{unusedWorkers:[worker],pthreads:{},getNewWorker(){return this.unusedWorkers.pop()},cleanThread(){}}}
    return module
  },async received=>{
    assert.equal(received,module)
    assert.equal(received.PThread.getNewWorker(),worker)
    return {instance:'native'}
  },new Uint8Array(),{onCreateWorker:()=>new FakeWorker()})
  assert.equal(result.napiModule,module)
  assert.equal(result.instance,'native')
  result.nativeThreadPool.dispose()
})
