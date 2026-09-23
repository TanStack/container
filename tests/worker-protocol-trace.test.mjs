import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {traceWorkerProtocol} from './fixtures/worker-protocol-trace.mjs'

test('aggregate observer continues after bounded detail capture fills',()=>{
  class Worker extends EventEmitter{postMessage(){}}
  const module={Worker},rows=[],counts={start:0,'cleanup-thread':0}
  traceWorkerProtocol(module,row=>rows.push(row),1,Object.keys(counts),row=>counts[row.type]++)
  const worker=new module.Worker()
  for(let tid=1;tid<=4;tid++){
    worker.postMessage({__emnapi__:{type:'start',payload:{tid}}})
    worker.emit('message',{__emnapi__:{type:'cleanup-thread',payload:{tid}}})
  }
  assert.equal(rows.length,1)
  assert.deepEqual(counts,{start:4,'cleanup-thread':4})
})

test('lifecycle filtering preserves delivery without spending the capture budget',()=>{
  class Worker extends EventEmitter{postMessage(value){return value}}
  const module={Worker},rows=[],received=[]
  traceWorkerProtocol(module,row=>rows.push(row),2,['start','cleanup-thread'])
  const worker=new module.Worker()
  worker.on('message',value=>received.push(value))
  const noise={__emnapi__:{type:'async-send'}}
  for(let i=0;i<100;i++)worker.emit('message',noise)
  worker.postMessage({__emnapi__:{type:'start',payload:{tid:3}}})
  worker.emit('message',{__emnapi__:{type:'cleanup-thread',payload:{tid:3}}})
  worker.postMessage({__emnapi__:{type:'start',payload:{tid:4}}})
  assert.equal(received.length,101)
  assert.deepEqual(rows,[{worker:1,direction:'send',type:'start',tid:3},{worker:1,direction:'receive',type:'cleanup-thread',tid:3}])
})

test('worker protocol diagnostics preserve delivery and omit message bodies',()=>{
  class Worker extends EventEmitter{
    constructor(filename){super();this.filename=filename;this.sent=[]}
    postMessage(...args){this.sent.push(args);return 42}
  }
  const module={Worker},rows=[]
  traceWorkerProtocol(module,row=>rows.push(row),2)
  const worker=new module.Worker('fixture.js'),received=[]
  worker.on('message',value=>received.push(value))
  const message={__emnapi__:{type:'start',payload:{tid:43,body:'not recorded'}}}
  const transfer=[]
  assert.equal(worker.postMessage(message,transfer),42)
  worker.emit('message',message)
  worker.emit('message',message)
  assert.equal(worker.filename,'fixture.js')
  assert.equal(worker.sent[0][0],message)
  assert.equal(worker.sent[0][1],transfer)
  assert.deepEqual(received,[message,message])
  assert.deepEqual(rows,[{worker:1,direction:'send',type:'start',tid:43},{worker:1,direction:'receive',type:'start',tid:43}])
  assert.ok(worker instanceof Worker)
})
