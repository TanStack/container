import {test,expect} from 'vitest'
import {AsyncLocalStorage,AsyncResource as NativeResource,executionAsyncId as nativeId} from 'node:async_hooks'
import {EventEmitter,EventEmitterAsyncResource as NativeEmitter} from 'node:events'
// @ts-expect-error Guest JavaScript is tested directly against Node.
import {createAsyncResources,createAsyncEmitter} from '../src/sandbox/guest-async-resource.js'

const guest=createAsyncResources(AsyncLocalStorage)
async function resourceProbe(Resource:any,id:()=>number){
  const als=new AsyncLocalStorage<string>()
  const r=als.run('saved',()=>new Resource('probe',{triggerAsyncId:123}))
  const receiver={answer:42}
  const bound=r.bind(function(this:any,n:number){return [this.answer+n,als.getStore(),id()===r.asyncId()]})
  const value=als.run('caller',()=>bound.call(receiver,1))
  const promise=r.runInAsyncScope(async()=>{await Promise.resolve();return [als.getStore(),id()===r.asyncId()]})
  let thrown
  als.run('caller',()=>{try{r.runInAsyncScope(()=>{throw Error('failure')})}catch{thrown=als.getStore()}})
  const destroy=r.emitDestroy()===r
  return {value,promise:await promise,thrown,destroy,trigger:r.triggerAsyncId(),afterDestroy:r.runInAsyncScope(()=>als.getStore()),outside:als.getStore()}
}
test('resource scope, binding, promises, exceptions and destroy match Node',async()=>{
  expect(await resourceProbe(guest.AsyncResource,guest.executionAsyncId)).toEqual(await resourceProbe(NativeResource,nativeId))
})
test('async emitter listener context and receiver match Node',()=>{
  function probe(Emitter:any){
    const als=new AsyncLocalStorage<string>(),seen:any[]=[]
    const emitter=als.run('created',()=>new Emitter({name:'probe'}))
    emitter.on('test',function(this:any,n:number){seen.push([this===emitter,als.getStore(),n])})
    als.run('caller',()=>{seen.push(emitter.emit('test',42));seen.push(als.getStore())})
    seen.push(emitter.asyncResource.eventEmitter===emitter,emitter.emit('absent'))
    emitter.emitDestroy()
    return seen
  }
  expect(probe(createAsyncEmitter(EventEmitter,guest.AsyncResource))).toEqual(probe(NativeEmitter))
})
