import {test,expect} from 'vitest'
import native from 'node:stream/consumers'
import {Readable} from 'node:stream'
// @ts-expect-error The guest source intentionally has no declaration file.
import * as guest from '../src/sandbox/guest-stream-consumers.js'

const snapshot=async(api:any,source:()=>AsyncIterable<unknown>)=>{
  const binary=await api.buffer(source() as any)
  const byteArray=await api.bytes(source() as any)
  const array=await api.arrayBuffer(source() as any)
  const valueBlob=await api.blob(source() as any)
  return {binary:[...binary],bytes:[...byteArray],bytesType:byteArray.constructor.name,bytesIsBuffer:Buffer.isBuffer(byteArray),bytesOffset:byteArray.byteOffset,array:[...new Uint8Array(array)],blob:[...new Uint8Array(await valueBlob.arrayBuffer())],type:valueBlob.type}
}
const utf8=()=>Readable.from([Buffer.from([0x41,0xf0,0x9f]),Buffer.from([0xa6]),Buffer.from([0x8a,0x42])])

test('binary consumers and split UTF-8 match native Node for Readable and async iterables',async()=>{
  expect(await snapshot(guest as any,utf8)).toEqual(await snapshot(native,utf8))
  const iterable=()=>({async *[Symbol.asyncIterator](){yield new Uint8Array([0,255]);yield 'ok'}})
  expect(await snapshot(guest as any,iterable)).toEqual(await snapshot(native,iterable))
  expect(await guest.text(utf8())).toBe(await native.text(utf8()))
})

test('JSON failures, stream errors and second consumption match native Node',async()=>{
  for(const api of [native,guest as any]){
    await expect(api.json(Readable.from(['{"ok":true}']))).resolves.toEqual({ok:true})
    await expect(api.json(Readable.from(['{"broken"']))).rejects.toBeInstanceOf(SyntaxError)
    const failure=Object.assign(Error('stream failed'),{code:'EFAIL'})
    await expect(api.text(Readable.from((async function*(){yield 'prefix';throw failure})()))).rejects.toMatchObject({message:'stream failed',code:'EFAIL'})
  }
  const nativeStream=Readable.from(['once']),guestStream=Readable.from(['once'])
  expect([await native.text(nativeStream),await native.text(nativeStream)]).toEqual([await guest.text(guestStream),await guest.text(guestStream)])
})

test('Web ReadableStream consumption matches native Node',async()=>{
  const web=()=>new ReadableStream({start(controller){controller.enqueue(new Uint8Array([0x68,0xc3]));controller.enqueue(new Uint8Array([0xa9]));controller.close()}})
  expect(await guest.text(web())).toBe(await native.text(web() as any))
  expect(await snapshot(guest as any,web as any)).toEqual(await snapshot(native,web as any))
  const nativeStream=web(),guestStream=web()
  expect([await native.text(nativeStream as any),await native.text(nativeStream as any)]).toEqual([await guest.text(guestStream),await guest.text(guestStream)])
})
