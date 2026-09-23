import {it,expect} from 'vitest'
import {TrustedInitializerCache} from '../src/sandbox/trusted-initializer-cache'

it('compiles once and keeps producer and consumer mutations out of retained bytes',()=>{
  const engine={},cache=new TrustedInitializerCache(engine),produced=new Uint8Array([1,2]);let calls=0
  const compile=()=>{calls++;return produced}
  cache.use(engine,'source',compile,bytes=>{bytes[0]=9});produced[1]=8
  expect(cache.use(engine,'source',compile,bytes=>[...bytes])).toEqual([1,2])
  expect(calls).toBe(1);expect(cache.retainedBytes).toBe(2)
})
it('does not reuse bytes across engine instances or sources',()=>{
  const engine={},cache=new TrustedInitializerCache(engine)
  cache.use(engine,'one',()=>new Uint8Array([1]),()=>{})
  expect(()=>cache.use({},'one',()=>new Uint8Array([1]),()=>{})).toThrow('different engine')
  expect(()=>cache.use(engine,'two',()=>new Uint8Array([1]),()=>{})).toThrow('source is already fixed')
})
it('retries compilation failures without retaining partial bytes',()=>{
  const engine={},cache=new TrustedInitializerCache(engine,2)
  expect(()=>cache.use(engine,'source',()=>{throw Error('compile failed')},()=>{})).toThrow('compile failed')
  expect(cache.retainedBytes).toBe(0)
  expect(()=>cache.use(engine,'source',()=>new Uint8Array(3),()=>{})).toThrow('limit')
  expect(cache.retainedBytes).toBe(0)
  expect(cache.use(engine,'source',()=>new Uint8Array([7]),bytes=>bytes[0])).toBe(7)
})
it('releases its entry and rejects use after close',()=>{
  const engine={},cache=new TrustedInitializerCache(engine)
  cache.use(engine,'source',()=>new Uint8Array([1]),()=>{});cache.close();cache.close()
  expect(cache.retainedBytes).toBe(0)
  expect(()=>cache.use(engine,'source',()=>new Uint8Array([1]),()=>{})).toThrow('closed')
})
it('does not publish bytes if closed during compilation',()=>{
  const engine={},cache=new TrustedInitializerCache(engine)
  expect(()=>cache.use(engine,'source',()=>{cache.close();return new Uint8Array([1])},()=>{})).toThrow('closed')
  expect(cache.retainedBytes).toBe(0)
})
it('rejects recursive compilation and keeps valid bytes after evaluation errors',()=>{
  const engine={},cache=new TrustedInitializerCache(engine),compile=()=>new Uint8Array([1])
  expect(()=>cache.use(engine,'source',()=>cache.use(engine,'source',compile,bytes=>bytes),()=>{})).toThrow('already active')
  expect(()=>cache.use(engine,'source',compile,()=>{throw Error('evaluation failed')})).toThrow('evaluation failed')
  expect(cache.use(engine,'source',()=>{throw Error('must reuse')},bytes=>bytes[0])).toBe(1)
})
