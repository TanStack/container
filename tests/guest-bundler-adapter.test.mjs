import test from 'node:test'
import assert from 'node:assert/strict'
import {AsyncLocalStorage} from 'node:async_hooks'
import {createGuestBundlerAdapter} from '../src/compiler/guest-bundler-adapter.js'

function harness(){
  let sequence=0
  const queues=new Map(),waiters=new Map(),starts=[],replies=[],finished=[],cancelled=[]
  const scope=new AsyncLocalStorage()
  const send=(id,event)=>{const waiter=waiters.get(id);if(waiter){waiters.delete(id);waiter(event)}else queues.get(id).push(event)}
  const transport={
    create:()=>1,
    start(handle,method,options){const id=++sequence;queues.set(id,[]);starts.push({id,method,options});if(method==='close')send(id,{type:'result',value:undefined});return id},
    next(id){const queue=queues.get(id);return queue.length?Promise.resolve(queue.shift()):new Promise(resolve=>waiters.set(id,resolve))},
    reply(id,callback,value){replies.push({id,callback,value});transport.onReply?.(callback,value)},
    finish:id=>finished.push(id),cancel:id=>cancelled.push(id),reportError:()=>{},
    context(){throw Error('No context handler')},
  }
  const Binding=createGuestBundlerAdapter(transport,scope,value=>value,{maxBytes:65536})
  const complete=(id,result={chunks:[]})=>send(id,{type:'result',value:{result,watchFiles:['/entry.js'],closed:false}})
  return {Binding,transport,scope,send,complete,starts,replies,finished,cancelled}
}
const tick=()=>new Promise(resolve=>setImmediate(resolve))

test('nested async context callbacks are serviced while their parent awaits, with separate ALS scopes',async()=>{
  const h=harness(),origin=new AsyncLocalStorage(),bundler=new h.Binding(),seen=[]
  let resolveContext,retained
  h.transport.context=(scope,handle,method,args)=>{
    assert.equal(scope,10);assert.equal(method,'resolve');assert.deepEqual(args,['nested'])
    h.send(1,{type:'callback',id:2,callbackId:h.starts[0].options.second.id,args:[],scope:20,sync:false})
    return new Promise(resolve=>resolveContext=resolve)
  }
  h.transport.onReply=(id,reply)=>{if(id===2)resolveContext(reply.value);else h.complete(1)}
  const promise=origin.run('request-A',()=>bundler.generate({
    first:async ctx=>{retained=ctx;seen.push([origin.getStore(),h.scope.getStore()]);const result=await ctx.resolve('nested');seen.push([origin.getStore(),h.scope.getStore()]);return result},
    second:async()=>{await Promise.resolve();seen.push([origin.getStore(),h.scope.getStore()]);return 'resolved'},
  }))
  h.send(1,{type:'callback',id:1,callbackId:h.starts[0].options.first.id,args:[{type:'native-context',handle:1,scope:10,methods:['resolve']}],scope:10,sync:false})
  await promise
  assert.deepEqual(seen,[['request-A',10],['request-A',20],['request-A',10]])
  assert.deepEqual(h.replies.map(x=>x.callback),[2,1])
  assert.throws(()=>retained.resolve('late'),/Expired/)
  await bundler.close()
})

test('option values preserve callback identity, regex, bytes and undefined',async()=>{
  const h=harness(),b=new h.Binding(),fn=()=>undefined
  const pending=b.generate({a:fn,b:fn,filter:/foo/gi,source:new Uint8Array([0,255]),missing:undefined})
  const options=h.starts[0].options
  assert.deepEqual(options.a,options.b)
  assert.deepEqual(options.filter,{type:'RegExp',source:'foo',flags:'gi'})
  assert.deepEqual(options.source,{type:'bytes',value:[0,255]})
  h.send(1,{type:'callback',id:1,callbackId:options.a.id,args:[],scope:1,sync:true})
  await tick();assert.deepEqual(h.replies[0].value,{type:'value',value:{type:'undefined'}})
  h.complete(1);await pending;assert.deepEqual(b.getWatchFiles(),['/entry.js']);await b.close()
})

test('synchronous callback promise is rejected, not awaited as a sync value',async()=>{
  const h=harness(),b=new h.Binding(),pending=b.generate({fn:async()=>42})
  h.send(1,{type:'callback',id:1,callbackId:h.starts[0].options.fn.id,args:[],scope:1,sync:true})
  await tick();assert.match(h.replies[0].value.error.value.message,/returned a Promise/)
  h.complete(1);await pending;await b.close()
})

test('context inner is synchronous, unsupported methods reject and error fields survive',async()=>{
  const h=harness(),b=new h.Binding(),pending=b.generate({fn:ctx=>{
    assert.equal(typeof ctx.inner().resolve,'function')
    assert.throws(()=>ctx.inner().emitFile({}),{code:'ERR_UNSUPPORTED_OPERATION'})
    throw Object.assign(new Error('owned failure'),{code:'OWNED',cause:new Error('cause')})
  }})
  h.send(1,{type:'callback',id:1,callbackId:h.starts[0].options.fn.id,args:[{type:'native-context',handle:1,scope:1,methods:['inner'],inner:{type:'native-context',handle:2,scope:1,methods:['resolve','emitFile']}}],scope:1,sync:false})
  await tick()
  assert.equal(h.replies[0].value.error.value.code,'OWNED')
  assert.equal(h.replies[0].value.error.value.cause.value.message,'cause')
  h.complete(1);await pending;await b.close()
})

test('payload cycles reject before transport and result waits for callback replies',async()=>{
  const h=harness(),b=new h.Binding(),cycle={};cycle.self=cycle
  await assert.rejects(b.generate(cycle),/Cyclic/);assert.equal(h.starts.length,0)
  let release,settled=false
  const pending=b.generate({fn:()=>new Promise(resolve=>release=resolve)}).then(()=>settled=true)
  h.send(1,{type:'callback',id:1,callbackId:h.starts[0].options.fn.id,args:[],scope:1,sync:false})
  h.complete(1);await tick();assert.equal(settled,false)
  release(null);await pending;assert.deepEqual(h.replies[0].value,{type:'value',value:null});await b.close()
})

test('close cancels an unresolved callback and drains it before native close',async()=>{
  const h=harness(),b=new h.Binding(),pending=b.generate({fn:()=>new Promise(()=>{})})
  const rejected=assert.rejects(pending,/cancelled/)
  h.send(1,{type:'callback',id:1,callbackId:h.starts[0].options.fn.id,args:[],scope:1,sync:false})
  await tick();await b.close();await rejected
  assert.equal(b.closed,true);assert.deepEqual(h.finished,[1,2]);assert.deepEqual(h.replies,[])
})

test('runtime notifications require matching adapted lifecycles and scan allows native void',async()=>{
  const h=harness()
  assert.throws(()=>h.Binding.startAsyncRuntime(),/without an adapted/)
  const b=new h.Binding();h.Binding.startAsyncRuntime()
  const pending=b.scan({});h.send(1,{type:'result',value:{result:undefined,watchFiles:[],closed:false}})
  assert.equal(await pending,undefined)
  await b.close();h.Binding.shutdownAsyncRuntime()
  assert.throws(()=>h.Binding.shutdownAsyncRuntime(),/without a settled/)
  assert.throws(()=>new (h.Binding.unsupportedRuntimeConstructor('BindingWatcher'))(),/BindingWatcher/)
})
