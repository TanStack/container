import {expect,test,vi} from 'vitest'
import {PackageInstallCache} from '../src/npm/install'
test('one cancelled caller does not abort another archive consumer',async()=>{
  const cache=new PackageInstallCache()
  let release!:(value:Uint8Array)=>void
  let shared!:AbortSignal
  const load=vi.fn((signal?:AbortSignal)=>{shared=signal!;return new Promise<Uint8Array>(resolve=>{release=resolve})})
  const controller=new AbortController(),reason=Error('cancel one')
  const first=cache.archive('test-shared',load,controller.signal)
  const second=cache.archive('test-shared',load)
  const rejected=expect(first).rejects.toBe(reason)
  await vi.waitFor(()=>expect(load).toHaveBeenCalledOnce())
  controller.abort(reason)
  await rejected
  expect(shared.aborted).toBe(false)
  const bytes=new Uint8Array([42])
  release(bytes)
  await expect(second).resolves.toBe(bytes)
})
test('last cancelled caller aborts shared work and permits a fresh retry',async()=>{
  const cache=new PackageInstallCache()
  let shared!:AbortSignal
  const controller=new AbortController(),reason=Error('cancel last')
  const load=vi.fn((signal?:AbortSignal)=>{shared=signal!;return new Promise<Uint8Array>((_,reject)=>signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true}))})
  const pending=cache.archive('test-retry',load,controller.signal)
  const rejected=expect(pending).rejects.toBe(reason)
  await vi.waitFor(()=>expect(load).toHaveBeenCalledOnce())
  controller.abort(reason)
  await rejected
  expect(shared.reason).toBe(reason)
  const bytes=new Uint8Array([7])
  await expect(cache.archive('test-retry',async()=>bytes)).resolves.toBe(bytes)
})
