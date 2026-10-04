import {expect,test} from 'vitest'
import {NativeAsyncLocalStorage,NativeAsyncResource,executionAsyncId} from '../src/native/async-context'

test('resources capture context and restore it after a callback throws',()=>{
  const storage=new NativeAsyncLocalStorage<string>()
  const resource=storage.run('origin',()=>new NativeAsyncResource('task'))
  storage.run('caller',()=>{
    expect(()=>resource.runInAsyncScope(function(this:{value:number},argument:number){
      expect(storage.getStore()).toBe('origin')
      expect(executionAsyncId()).toBe(resource.asyncId())
      expect(this.value+argument).toBe(5)
      const child=new NativeAsyncResource('child')
      expect(child.triggerAsyncId()).toBe(resource.asyncId())
      throw new Error('task failed')
    },{value:2},3)).toThrow('task failed')
    expect(storage.getStore()).toBe('caller')
    expect(executionAsyncId()).toBe(0)
  })
  expect(storage.getStore()).toBeUndefined()
})

test('bound callbacks preserve context, receiver and arguments',()=>{
  const storage=new NativeAsyncLocalStorage<string>()
  const callback=storage.run('origin',()=>NativeAsyncResource.bind(function(this:{value:number},n:number){
    return [storage.getStore(),this.value+n]
  }))
  expect(callback.call({value:2},3)).toEqual(['origin',5])
  const resource=new NativeAsyncResource('task')
  expect(resource.bind(function(this:{value:number}){return this.value},{value:7})()).toBe(7)
  expect(resource.emitDestroy()).toBe(resource)
})
