import {readFileSync} from 'node:fs'
import {Worker} from 'node:worker_threads'

const check=(condition,message)=>{if(!condition)throw Error(message)}
const memory=new WebAssembly.Memory({initial:1,maximum:2,shared:true})
const module=new WebAssembly.Module(readFileSync(new URL('./atomic.wasm',import.meta.url)))
const api=new WebAssembly.Instance(module,{env:{memory}}).exports
const oldView=new Int32Array(memory.buffer)
check(memory.buffer instanceof SharedArrayBuffer,'Memory must expose shared storage')
api.store(0,10)
check(api.add(0,2)===10,'Atomic RMW must return the old value')
check(api.load(0)===12,'Atomic store/load/RMW must agree')
const worker=new Worker(new URL('./worker.mjs',import.meta.url),{workerData:{module,memory}})
const messages=[],waiters=[]
worker.on('message',message=>{const waiter=waiters.shift();if(waiter)waiter.resolve(message);else messages.push(message)})
worker.on('error',error=>{for(const waiter of waiters.splice(0))waiter.reject(error)})
const next=()=>messages.length?Promise.resolve(messages.shift()):new Promise((resolve,reject)=>waiters.push({resolve,reject}))
const watchdog=setTimeout(()=>{worker.terminate();throw Error('Shared worker fixture timed out')},5000)
try{
  const ready=await next()
  check(ready.type==='ready'&&ready.old===12&&api.load(0)===15,'Worker must share the same backing store')
  // Wait on word 1 while the peer runs and notifies it. Retrying notify avoids
  // relying on a timer delay to guess whether the parent is already waiting.
  worker.postMessage({type:'notify'})
  check(api.wait(4,0,2000000000n)===0,'WASM wait must wake from peer notification')
  const notified=await next()
  check(notified.type==='notified'&&notified.count===1,'Peer must observe a waiting parent')
  check(memory.grow(1)===1,'Shared memory must grow from one page')
  const freshView=new Int32Array(memory.buffer)
  check(oldView.byteLength===65536&&freshView.byteLength===131072,'Shared growth must preserve old views')
  freshView[16384]=27
  worker.postMessage({type:'grown'})
  const grown=await next()
  check(grown.type==='grown'&&grown.oldLength===65536&&grown.newLength===131072&&grown.value===27,'Worker must observe memory growth')
  check(oldView[0]===16&&api.load(0)===16,'Old shared view must remain live after growth')
  console.log(JSON.stringify({counter:api.load(0),notified:notified.count,oldBytes:oldView.byteLength,newBytes:freshView.byteLength,upperPage:grown.value}))
}finally{clearTimeout(watchdog);await worker.terminate()}
