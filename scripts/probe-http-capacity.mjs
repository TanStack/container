import assert from 'node:assert/strict'
import {acquireHTTPCapacity} from '../src/sandbox/http-capacity.ts'
const owner={}
const releases=await Promise.all(Array.from({length:32},()=>acquireHTTPCapacity(owner,new AbortController().signal)))
let acquired=false
const waiting=acquireHTTPCapacity(owner,new AbortController().signal).then(release=>{acquired=true;return release})
await Promise.resolve()
assert.equal(acquired,false)
const controller=new AbortController()
const cancelled=acquireHTTPCapacity(owner,controller.signal)
controller.abort(Error('cancelled'))
await assert.rejects(cancelled,/cancelled/)
releases[0]()
const release=await waiting
assert.equal(acquired,true)
release();release()
for(const done of releases)done()
const reused=await Promise.all(Array.from({length:32},()=>acquireHTTPCapacity(owner,new AbortController().signal)))
for(const done of reused)done()
const preAborted=new AbortController()
preAborted.abort(Error('already cancelled'))
await assert.rejects(acquireHTTPCapacity(owner,preAborted.signal),/already cancelled/)
// Independent workspaces must not share a connection budget.
const held=await Promise.all(Array.from({length:32},()=>acquireHTTPCapacity(owner,new AbortController().signal)))
const independent=await acquireHTTPCapacity({},new AbortController().signal)
independent()
const order=[]
const queued=Array.from({length:96},(_,index)=>acquireHTTPCapacity(owner,new AbortController().signal).then(done=>{
  order.push(index)
  done()
}))
await Promise.resolve()
assert.deepEqual(order,[])
held[0]()
await Promise.all(queued)
assert.deepEqual(order,Array.from({length:96},(_,index)=>index))
for(const done of held)done()
for(let round=0;round<20;round++){
  const slots=await Promise.all(Array.from({length:32},()=>acquireHTTPCapacity(owner,new AbortController().signal)))
  const abort=new AbortController()
  const pending=acquireHTTPCapacity(owner,abort.signal)
  abort.abort(Error('cycle cancelled'))
  await assert.rejects(pending,/cycle cancelled/)
  for(const done of slots)done()
}
console.log('HTTP capacity queue, cancellation, release, and reuse matched')
console.log('Independent owners, FIFO fanout, pre-abort, and 20 cancellation cycles matched')
