import {test,expect,vi} from 'vitest'
import {SharedAsset} from '../src/sandbox/shared-asset'

function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}

test('keeps a shared load alive for its remaining consumer and caches success',async()=>{
  const pending=deferred<number>();let loadSignal!:AbortSignal
  const load=vi.fn(async(_key:string,signal:AbortSignal)=>{loadSignal=signal;return pending.promise})
  const cache=new SharedAsset(load),first=new AbortController(),second=new AbortController()
  const a=cache.acquire('engine',first.signal),b=cache.acquire('engine',second.signal)
  const assertion=expect(a).rejects.toBe('cancelled')
  first.abort('cancelled');await assertion
  expect(loadSignal.aborted).toBe(false)
  pending.resolve(42);expect(await b).toBe(42)
  expect(await cache.acquire('engine',new AbortController().signal)).toBe(42)
  expect(load).toHaveBeenCalledOnce()
})

test('abandons the last consumer and ignores stale load completion on retry',async()=>{
  const old=deferred<number>(),fresh=deferred<number>();const signals:AbortSignal[]=[]
  const cache=new SharedAsset(async(_key,signal)=>{signals.push(signal);return signals.length===1?old.promise:fresh.promise})
  const first=new AbortController(),a=cache.acquire('engine',first.signal)
  await Promise.resolve()
  const assertion=expect(a).rejects.toBe('cancelled');first.abort('cancelled');await assertion
  expect(signals[0].aborted).toBe(true)
  const b=cache.acquire('engine',new AbortController().signal)
  await Promise.resolve();expect(signals).toHaveLength(2)
  old.resolve(1);fresh.resolve(42);expect(await b).toBe(42)
  expect(await cache.acquire('engine',new AbortController().signal)).toBe(42)
  expect(signals).toHaveLength(2)
})

test('failed loads are retryable and pre-cancelled callers do not load',async()=>{
  const load=vi.fn().mockRejectedValueOnce(Error('failed')).mockResolvedValue(42)
  const cache=new SharedAsset<number>(load),cancelled=new AbortController();cancelled.abort('stopped')
  await expect(cache.acquire('engine',cancelled.signal)).rejects.toBe('stopped');expect(load).not.toHaveBeenCalled()
  await expect(cache.acquire('engine',new AbortController().signal)).rejects.toThrow('failed')
  expect(await cache.acquire('engine',new AbortController().signal)).toBe(42)
  expect(load).toHaveBeenCalledTimes(2)
})
