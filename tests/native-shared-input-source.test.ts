import {test,expect} from 'vitest'
import {NativeSharedInputSource} from '../src/native/shared-input-source'
test('shared read demand propagates upstream once until data arrives',async()=>{
  let demands=0
  const source=new NativeSharedInputSource(()=>demands++)
  const first=source.read({}),second=source.read({})
  expect(demands).toBe(1)
  await source.write(new Uint8Array([42]))
  expect(await first).toEqual(new Uint8Array([42]));expect(demands).toBe(2)
  await source.write(null);expect(await second).toBeNull();expect(demands).toBe(2)
})
test('competing readers consume distinct chunks without broadcasting',async()=>{
  const source=new NativeSharedInputSource(),parent={},child={}
  const first=source.read(parent),second=source.read(child)
  const bytes=new Uint8Array([0,128,255]);const receipt=source.write(bytes);bytes.fill(9)
  expect(await first).toEqual(new Uint8Array([0,128,255]));await receipt
  const next=source.write(new Uint8Array([10,65]))
  expect(await second).toEqual(new Uint8Array([10,65]));await next
  await source.write(null)
  expect(await source.read(parent)).toBeNull();expect(await source.read(child)).toBeNull()
})
test('write receipts wait for consumption and EOF follows queued bytes',async()=>{
  const source=new NativeSharedInputSource(),reader={};let settled=false
  const receipt=source.write(new Uint8Array([42])).then(()=>settled=true)
  await source.write(null);await Promise.resolve();expect(settled).toBe(false)
  expect(await source.read(reader)).toEqual(new Uint8Array([42]));await receipt
  expect(await source.read(reader)).toBeNull()
  expect(()=>source.write(new Uint8Array([1]))).toThrow(expect.objectContaining({code:'EPIPE'}))
})
test('cancelled reads do not consume bytes intended for another process',async()=>{
  const source=new NativeSharedInputSource(),controller=new AbortController(),reason=Error('cancelled')
  const pending=source.read({},controller.signal),rejected=expect(pending).rejects.toBe(reason)
  controller.abort(reason);await rejected
  const receipt=source.write(new Uint8Array([1]))
  expect(await source.read({})).toEqual(new Uint8Array([1]));await receipt
})
test('source closure rejects pending writes and reads with the original error',async()=>{
  const source=new NativeSharedInputSource(),error=Error('owner exited')
  const receipt=source.write(new Uint8Array([1])),rejected=expect(receipt).rejects.toBe(error)
  source.close(error);source.close();await rejected
  await expect(source.read({})).rejects.toBe(error)
  const other=new NativeSharedInputSource(),owner={}
  const pending=other.read(owner),cancelled=expect(pending).rejects.toBe(error)
  other.cancelReader(owner,error);await cancelled
})
test('queued bytes remain bounded while consumers are idle',async()=>{
  const source=new NativeSharedInputSource()
  const writes=Array.from({length:16},()=>source.write(new Uint8Array(65536)))
  const rejected=Promise.all(writes.map(write=>expect(write).rejects.toMatchObject({code:'EPIPE'})))
  expect(()=>source.write(new Uint8Array([1]))).toThrow('queue is full')
  source.close();await rejected
})
