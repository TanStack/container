import {expect,test} from 'vitest'
import {EventEmitterAsyncResource} from '../src/vite-browser/node-events'
import {NativeAsyncLocalStorage,executionAsyncId} from '../src/native/async-context'

test('listeners run in the emitter creation context and preserve normal event behavior',()=>{
  const storage=new NativeAsyncLocalStorage<string>()
  const emitter=storage.run('origin',()=>new EventEmitterAsyncResource({name:'test'}))
  const received:unknown[]=[]
  emitter.once('value',function(this:unknown,value:number){
    received.push(storage.getStore(),executionAsyncId(),this,value)
  })
  storage.run('caller',()=>{
    expect(emitter.emit('value',5)).toBe(true)
    expect(storage.getStore()).toBe('caller')
    expect(executionAsyncId()).toBe(0)
  })
  expect(received).toEqual(['origin',emitter.asyncId,emitter,5])
  expect(emitter.emit('value',6)).toBe(false)
  expect(emitter.asyncResource.eventEmitter).toBe(emitter)
})

test('listener exceptions restore context and unhandled error events still throw',()=>{
  const storage=new NativeAsyncLocalStorage<string>()
  const emitter=storage.run('origin',()=>new EventEmitterAsyncResource())
  emitter.on('value',()=>{throw new Error('listener failed')})
  storage.run('caller',()=>{
    expect(()=>emitter.emit('value')).toThrow('listener failed')
    expect(storage.getStore()).toBe('caller')
    expect(()=>emitter.emit('error',new Error('unhandled'))).toThrow('unhandled')
    expect(storage.getStore()).toBe('caller')
  })
})
