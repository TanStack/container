import {test} from 'node:test'
import assert from 'node:assert/strict'
import {AsyncLocalStorage} from 'node:async_hooks'
import {createGuestCallableDispatch} from '../src/compiler/guest-callable-dispatch.js'
function host(){
  let sequence=0
  const pending=new Map(),queued=new Map(),replies=[],errors=[],finished=[],cancelled=[]
  const transport={start(){return ++sequence},next(id){const queue=queued.get(id);if(queue?.length)return Promise.resolve(queue.shift());return new Promise(resolve=>pending.set(id,resolve))},reply(...args){replies.push(args)},reportError(error){errors.push(error)},finish(id){finished.push(id)},cancel(id){cancelled.push(id);pending.delete(id);queued.delete(id)}}
  function send(id,event){const resolve=pending.get(id);if(resolve){pending.delete(id);resolve(event)}else{if(!queued.has(id))queued.set(id,[]);queued.get(id).push(event)}}
  return {transport,send,replies,errors,finished,cancelled,dispatch:createGuestCallableDispatch(transport)}
}
const turn=()=>new Promise(resolve=>setImmediate(resolve))
test('interleaved invocation pumps preserve originating ALS, not host settlement context',async()=>{
  const h=host(),als=new AsyncLocalStorage(),seen=[]
  const handle=h.dispatch.register({resolveSubpathImports(id){seen.push([id,als.getStore()]);return id+':'+als.getStore()}})
  const a=als.run('A',()=>h.dispatch.invoke(handle,'resolveId',['a']))
  const b=als.run('B',()=>h.dispatch.invoke(handle,'resolveId',['b']))
  await turn()
  als.run('HOST',()=>{h.send(2,{type:'callback',id:1,method:'resolveSubpathImports',args:['b']});h.send(1,{type:'callback',id:1,method:'resolveSubpathImports',args:['a']})})
  await turn()
  assert.deepEqual(seen,[['b','B'],['a','A']])
  assert.deepEqual(h.replies,[[2,1,{type:'string',value:'b:B'}],[1,1,{type:'string',value:'a:A'}]])
  h.send(1,{type:'result',value:'one'});h.send(2,{type:'result',value:'two'})
  assert.deepEqual(await Promise.all([a,b]),['one','two']);h.dispatch.close()
})
test('primitive callback replies retain null and undefined, throws and promises stay explicit',async()=>{
  const h=host()
  const handle=h.dispatch.register({resolveSubpathImports(value){if(value==='throw')throw Error('callback failed');if(value==='promise')return Promise.resolve('later');return value}})
  const operation=h.dispatch.invoke(handle,'resolveId',[])
  for(const [index,value]of [null,undefined,'text','throw','promise'].entries()){h.send(1,{type:'callback',id:index,method:'resolveSubpathImports',args:[value]});await turn()}
  assert.deepEqual(h.replies.slice(0,3).map(row=>row[2]),[{type:'null'},{type:'undefined'},{type:'string',value:'text'}])
  assert.match(h.replies[3][2].message,/callback failed/);assert.match(h.replies[4][2].message,/returned a Promise/)
  h.send(1,{type:'result',value:null});assert.equal(await operation,null);h.dispatch.close()
})
test('async warning failure is reported separately without rejecting native operation',async()=>{
  const h=host()
  const handle=h.dispatch.register({async onWarn(){await Promise.resolve();throw Error('warning handler failed')}})
  const operation=h.dispatch.invoke(handle,'resolveId',[])
  h.send(1,{type:'callback',id:1,method:'onWarn',args:['warning']});await turn()
  assert.deepEqual(h.replies[0][2],{type:'undefined'});assert.deepEqual(h.errors,['Error: warning handler failed'])
  h.send(1,{type:'result',value:'resolved'});assert.equal(await operation,'resolved');h.dispatch.close()
})
test('close cancels pending pumps, release prevents reuse without losing in-flight callbacks',async()=>{
  const h=host(),handle=h.dispatch.register({onDebug(){}})
  const operation=h.dispatch.invoke(handle,'resolveId',[])
  h.dispatch.release(handle)
  await assert.rejects(h.dispatch.invoke(handle,'resolveId',[]),/released/)
  const rejected=assert.rejects(operation,/closed/)
  await turn();h.dispatch.close();h.dispatch.close();await rejected
  assert.deepEqual(h.cancelled,[1]);assert.deepEqual(h.finished,[1])
})
test('closing before the first job does not open a host wait after cancellation',async()=>{
  const h=host(),handle=h.dispatch.register({onDebug(){}})
  let waits=0;h.transport.next=()=>{waits++;return new Promise(()=>{})}
  const operation=h.dispatch.invoke(handle,'resolveId',[])
  h.dispatch.close()
  await assert.rejects(operation,/closed/)
  assert.equal(waits,0);assert.deepEqual(h.cancelled,[1]);assert.deepEqual(h.finished,[1])
})
test('an ordinary burst waits at 63 active operations and admitted callbacks retain caller ALS',async()=>{
  const h=host(),als=new AsyncLocalStorage(),seen=[],reserved=new Set(),released=[]
  let reservationSequence=0,starts=0,live=0,peak=0
  h.transport.reserve=()=>{const id=++reservationSequence;reserved.add(id);return id}
  h.transport.releaseReservation=id=>{assert.ok(reserved.delete(id));released.push(id)}
  h.transport.start=(handle,method,args,origin,reservation)=>{assert.ok(reserved.delete(reservation));starts++;peak=Math.max(peak,++live);return starts}
  h.transport.finish=()=>{live--}
  const handle=h.dispatch.register({resolveSubpathImports(){seen.push(als.getStore());return 'ok'}})
  const operations=Array.from({length:130},(_,index)=>als.run('request-'+index,()=>h.dispatch.invoke(handle,'resolveId',[index])))
  assert.equal(starts,63);assert.equal(reserved.size,67)
  for(let id=1;id<=130;id++){
    h.send(id,{type:'callback',id:1,method:'resolveSubpathImports',args:[]});await turn()
    h.send(id,{type:'result',value:id});await turn()
  }
  assert.deepEqual(await Promise.all(operations),Array.from({length:130},(_,index)=>index+1))
  assert.deepEqual(seen,Array.from({length:130},(_,index)=>'request-'+index))
  assert.equal(peak,63);assert.equal(live,0);assert.equal(reserved.size,0);assert.deepEqual(released,[])
})
test('release and close free waiting reservations without starting their work',async()=>{
  const h=host(),reserved=new Set();let sequence=0
  h.transport.reserve=()=>{reserved.add(++sequence);return sequence}
  h.transport.releaseReservation=id=>assert.ok(reserved.delete(id))
  const start=h.transport.start;h.transport.start=(...args)=>{reserved.delete(args[4]);return start()}
  const handle=h.dispatch.register({}),other=h.dispatch.register({})
  const active=Array.from({length:63},()=>h.dispatch.invoke(handle,'resolveId',[]))
  const first=h.dispatch.invoke(other,'resolveId',[]),second=h.dispatch.invoke(handle,'resolveId',[])
  const checks=[...active.map(p=>assert.rejects(p,/closed/)),assert.rejects(first,/released/),assert.rejects(second,/closed/)]
  h.dispatch.release(other);h.dispatch.close();await Promise.all(checks)
  assert.equal(reserved.size,0);assert.equal(h.cancelled.length,63);assert.equal(h.finished.length,63)
})
test('failed reserved starts free admission and permit queued successors',async()=>{
  const h=host(),reserved=new Set();let sequence=0
  h.transport.reserve=()=>{reserved.add(++sequence);return sequence}
  h.transport.releaseReservation=id=>assert.ok(reserved.delete(id))
  const start=h.transport.start;h.transport.start=(...args)=>{if(args[4]===64)throw Error('start failed');reserved.delete(args[4]);return start()}
  const handle=h.dispatch.register({}),operations=Array.from({length:66},()=>h.dispatch.invoke(handle,'resolveId',[]))
  const failure=assert.rejects(operations[63],/start failed/)
  h.send(1,{type:'result',value:1});await turn();await failure
  for(let id=2;id<=65;id++)h.send(id,{type:'result',value:id})
  await Promise.all(operations.filter((_,index)=>index!==63));assert.equal(reserved.size,0)
})
test('scoped calls unblock a saturated ordinary queue without exceeding 64 total credits',async()=>{
  const h=host(),scope=new AsyncLocalStorage(),starts=[]
  h.transport.isScoped=()=>scope.getStore()!==undefined
  const start=h.transport.start
  h.transport.start=(...args)=>{starts.push(scope.getStore());return start(...args)}
  const handle=h.dispatch.register({})
  const ordinary=Array.from({length:65},()=>h.dispatch.invoke(handle,'resolveId',[]))
  const first=scope.run('parent-A',()=>h.dispatch.invoke(handle,'resolveId',[]))
  const second=scope.run('parent-B',()=>h.dispatch.invoke(handle,'resolveId',[]))
  assert.equal(starts.length,64);assert.equal(starts[63],'parent-A')
  await turn();h.send(64,{type:'result',value:'A'});await first;await turn()
  // Two older ordinary requests cannot consume the reserved scoped credit.
  assert.equal(starts.length,65);assert.equal(starts[64],'parent-B')
  h.send(65,{type:'result',value:'B'});await second;await turn()
  assert.equal(starts.length,65)
  for(let id=1;id<=63;id++)h.send(id,{type:'result',value:id})
  await turn();assert.equal(starts.length,67)
  h.send(66,{type:'result',value:66});h.send(67,{type:'result',value:67})
  await Promise.all(ordinary);assert.equal(h.finished.length,67)
})
