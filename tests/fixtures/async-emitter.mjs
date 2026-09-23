import {EventEmitterAsyncResource} from 'node:events'
import {AsyncLocalStorage,executionAsyncId} from 'node:async_hooks'

const storage=new AsyncLocalStorage()
const emitter=storage.run('created',()=>new EventEmitterAsyncResource({name:'probe'}))
const seen=[]
let pending
emitter.on('value',function(value){
  seen.push(['listener',storage.getStore(),this===emitter,value,executionAsyncId()===emitter.asyncId])
  pending=Promise.resolve().then(()=>seen.push(['promise',storage.getStore()]))
})
const emitted=storage.run('caller',()=>{
  const result=emitter.emit('value',42)
  seen.push(['caller',storage.getStore()])
  return result
})
await pending
emitter.on('fail',()=>{throw Error('listener failure')})
storage.run('throwing caller',()=>{
  try{emitter.emit('fail')}catch(error){seen.push(['throw',error.message,storage.getStore()])}
})
seen.push(['resource',emitter.asyncResource.eventEmitter===emitter,emitter.asyncResource.asyncId()===emitter.asyncId])
seen.push(['return',emitted,emitter.emit('missing'),storage.getStore()??null])
emitter.emitDestroy()
console.log(JSON.stringify(seen))
