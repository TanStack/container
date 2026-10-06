import {afterEach,expect,test,vi} from 'vitest'
import {inspectBundledPackages} from '../src/npm/install'

const url='https://registry.npmjs.org/owned/-/owned-1.0.0.tgz'
// Valid lock syntax lets these tests reach the transport failure they check.
const integrity='sha512-'+Buffer.alloc(64).toString('base64')
afterEach(()=>vi.unstubAllGlobals())

test('network errors identify the package and retain their original cause',async()=>{
  const cause=new TypeError('NetworkError when attempting to fetch resource.')
  const fetch=vi.fn().mockRejectedValue(cause)
  vi.stubGlobal('fetch',fetch)
  const error=await inspectBundledPackages(url,integrity).catch(error=>error)
  expect(error.message).toBe('Could not download /owned/-/owned-1.0.0.tgz: TypeError: NetworkError when attempting to fetch resource.')
  expect(error.cause).toBe(cause)
  expect(fetch).toHaveBeenCalledOnce()
  expect(fetch.mock.calls[0][1]).toMatchObject({credentials:'omit',redirect:'error'})
})

test('download cancellation keeps the exact caller reason',async()=>{
  const controller=new AbortController(),reason=Error('cancel owned download')
  vi.stubGlobal('fetch',vi.fn(async()=>{controller.abort(reason);throw new DOMException('Aborted','AbortError')}))
  await expect(inspectBundledPackages(url,integrity,undefined,controller.signal)).rejects.toBe(reason)
})

test('HTTP failure retains status and package path',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status:503})))
  await expect(inspectBundledPackages(url,integrity)).rejects.toThrow('Could not download /owned/-/owned-1.0.0.tgz (503)')
})

test('HTTP failure cancels its body without waiting for stalled cleanup',async()=>{
  let cancelReason:unknown
  const cancel=vi.fn((reason:unknown)=>{cancelReason=reason;return new Promise<void>(()=>{})})
  const body=new ReadableStream<Uint8Array>({cancel},{highWaterMark:0})
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(body,{status:503})))
  const error=await inspectBundledPackages(url,integrity).catch(error=>error)
  expect(error.message).toBe('Could not download /owned/-/owned-1.0.0.tgz (503)')
  expect(cancel).toHaveBeenCalledOnce()
  expect(cancelReason).toBe(error)
})

test('archive body failures identify the package and preserve the cause',async()=>{
  const cause=new TypeError('Load failed')
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(new ReadableStream({start(controller){controller.error(cause)}}))))
  const error=await inspectBundledPackages(url,integrity).catch(error=>error)
  expect(error.message).toBe('Could not read archive /owned/-/owned-1.0.0.tgz: TypeError: Load failed')
  expect(error.cause).toBe(cause)
})

test('archive body cancellation preserves the caller reason',async()=>{
  const controller=new AbortController(),reason=Error('cancel archive body')
  const body=new ReadableStream<Uint8Array>({pull(){controller.abort(reason);return new Promise<void>(()=>{})}},{highWaterMark:0})
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(body)))
  await expect(inspectBundledPackages(url,integrity,undefined,controller.signal)).rejects.toBe(reason)
})
