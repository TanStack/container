import {test,expect} from 'vitest'
import native from 'node:buffer'
import browserBuffer from 'buffer/'
// @ts-expect-error Compiler helper intentionally has no declaration file.
import {createBufferExtras} from '../src/compiler/buffer-extras.js'

const browserKMaxLength=(browserBuffer as any).kMaxLength
const guest=createBufferExtras(Buffer,Blob,File,TextDecoder,TextEncoder,browserKMaxLength)
const result=(api:any,value:any)=>({ascii:api.isAscii(value),utf8:api.isUtf8(value)})
test('ASCII and UTF-8 validation matches native byte boundaries and input errors',()=>{
  for(const value of [new Uint8Array(),new Uint8Array([0,127]),new Uint8Array([128]),new Uint8Array([0xf0,0x9f,0xa6,0x8a]),new Uint8Array([0xc3,0x28]),new ArrayBuffer(2)])expect(result(guest,value)).toEqual(result(native,value))
  for(const value of [new DataView(new ArrayBuffer(1)),'bytes',null])for(const name of ['isAscii','isUtf8'])expect(()=>guest[name](value)).toThrow(expect.objectContaining({code:'ERR_INVALID_ARG_TYPE'}))
})
test('object URLs resolve only inside their owning guest registry and revoke cleanly',async()=>{
  const URLA=class {},URLB=class {}
  const a=createBufferExtras(Buffer,Blob,File,TextDecoder,TextEncoder,browserKMaxLength,URLA,true,1)
  const b=createBufferExtras(Buffer,Blob,File,TextDecoder,TextEncoder,browserKMaxLength,URLB,true,2)
  const original=new Blob(['hello'],{type:'text/plain'}),url=(URLA as any).createObjectURL(original)
  expect(url).toMatch(/^blob:nodedata:[0-9a-f-]{36}$/)
  const resolved=a.resolveObjectURL(url)
  expect(resolved).toBeInstanceOf(Blob);expect(resolved).not.toBe(original);expect(await resolved.text()).toBe('hello');expect(resolved.type).toBe('text/plain')
  expect(b.resolveObjectURL(url)).toBeUndefined();expect(a.resolveObjectURL(null)).toBeUndefined()
  const otherURL=(URLB as any).createObjectURL(new Blob(['other']));expect(otherURL).not.toBe(url);expect(a.resolveObjectURL(otherURL)).toBeUndefined()
  ;(URLB as any).revokeObjectURL(url);expect(a.resolveObjectURL(url)).toBeInstanceOf(Blob)
  ;(URLA as any).revokeObjectURL(url);expect(a.resolveObjectURL(url)).toBeUndefined()
  expect(()=>{(URLA as any).createObjectURL('not a blob')}).toThrow(expect.objectContaining({code:'ERR_INVALID_ARG_TYPE'}))
  const nativeBlob=new native.Blob(['hello'],{type:'text/plain'}),nativeURL=URL.createObjectURL(nativeBlob as any),nativeResolved=native.resolveObjectURL(nativeURL)!
  expect([nativeURL.startsWith('blob:nodedata:'),nativeResolved!==nativeBlob,await nativeResolved.text(),nativeResolved.type]).toEqual([true,true,'hello','text/plain'])
  URL.revokeObjectURL(nativeURL);expect(native.resolveObjectURL(nativeURL)).toBeUndefined()
})
test('supported transcoding, constructors and constants match representative native behavior',()=>{
  for(const [value,from,to] of [[Buffer.from([0x68,0xe9]),'latin1','utf8'],[Buffer.from([65,0,0xac,0x20]),'utf16le','utf8'],[Buffer.from('hello'),'utf8','utf16le'],[Buffer.from([0xc3,0x28]),'utf8','utf8']] as const)expect([...guest.transcode(value,from,to)]).toEqual([...native.transcode(value,from,to)])
  expect(()=>guest.transcode(Buffer.from('x'),'hex','utf8')).toThrow(expect.objectContaining({code:'U_ILLEGAL_ARGUMENT_ERROR'}))
  expect(()=>guest.transcode(new ArrayBuffer(1),'utf8','utf8')).toThrow(expect.objectContaining({code:'ERR_INVALID_ARG_TYPE'}))
  expect(guest.Blob).toBe(Blob);expect(guest.File).toBe(File)
  expect(guest.kStringMaxLength).toBe(native.kStringMaxLength)
  expect(guest.constants).toEqual({MAX_LENGTH:browserKMaxLength,MAX_STRING_LENGTH:native.kStringMaxLength})
})
