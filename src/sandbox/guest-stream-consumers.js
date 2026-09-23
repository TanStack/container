import {Buffer} from 'node:buffer'
import {TextDecoder} from 'node:util'

const chunkBytes=chunk=>{
  if(typeof chunk==='string')return Buffer.from(chunk)
  if(chunk instanceof ArrayBuffer)return Buffer.from(chunk)
  if(ArrayBuffer.isView(chunk))return Buffer.from(chunk.buffer,chunk.byteOffset,chunk.byteLength)
  throw Object.assign(new TypeError('The stream yielded an unsupported chunk type'),{code:'ERR_INVALID_ARG_TYPE'})
}
async function chunks(stream){
  const values=[]
  for await(const chunk of stream)values.push(chunkBytes(chunk))
  return values
}

export async function buffer(stream){return Buffer.concat(await chunks(stream))}
export async function bytes(stream){return new Uint8Array(await buffer(stream))}
export async function arrayBuffer(stream){
  const value=await buffer(stream)
  return value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength)
}
export async function text(stream){
  const decoder=new TextDecoder(),parts=[]
  for await(const chunk of stream)parts.push(decoder.decode(chunkBytes(chunk),{stream:true}))
  parts.push(decoder.decode())
  return parts.join('')
}
export async function json(stream){return JSON.parse(await text(stream))}
export async function blob(stream){
  if(typeof globalThis.Blob!=='function')throw Object.assign(new Error('Blob is unavailable in this runtime'),{code:'ERR_UNSUPPORTED_OPERATION'})
  return new Blob(await chunks(stream))
}

export default {arrayBuffer,blob,buffer,bytes,json,text}
