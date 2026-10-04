import crypto from 'crypto-browserify'

function withBase64urlDigest<T extends {digest:(encoding?:string)=>unknown}>(value:T):T{
  const digest=value.digest.bind(value)
  value.digest=((encoding?:string)=>encoding==='base64url'
    ?(digest() as {toString:(encoding:string)=>string}).toString('base64url')
    :digest(encoding)) as T['digest']
  return value
}

export const createHash=(...args:Parameters<typeof crypto.createHash>)=>withBase64urlDigest(crypto.createHash(...args))
export function hash(algorithm:string,data:string|ArrayBufferView,outputEncoding?:string){
  const digest=createHash(algorithm).update(data).digest()
  return outputEncoding?digest.toString(outputEncoding as BufferEncoding):digest
}
export const createHmac=(...args:Parameters<typeof crypto.createHmac>)=>withBase64urlDigest(crypto.createHmac(...args))
export const randomBytes = crypto.randomBytes.bind(crypto)

export function timingSafeEqual(left:ArrayBufferView,right:ArrayBufferView):boolean{
  if(!ArrayBuffer.isView(left)||!ArrayBuffer.isView(right))throw Object.assign(TypeError('Expected ArrayBufferView arguments'),{code:'ERR_INVALID_ARG_TYPE'})
  if(left.byteLength!==right.byteLength)throw Object.assign(RangeError('Input buffers must have the same byte length'),{code:'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH'})
  const a=new Uint8Array(left.buffer,left.byteOffset,left.byteLength)
  const b=new Uint8Array(right.buffer,right.byteOffset,right.byteLength)
  let difference=0
  for(let index=0;index<a.length;index++)difference|=a[index]^b[index]
  // JavaScript engines do not guarantee constant-time machine code. This
  // adapter provides Node's value and error semantics for virtual sockets.
  return difference===0
}

export function getRandomValues<T extends ArrayBufferView>(array: T): T {
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    return globalThis.crypto.getRandomValues(array) as T
  }
  const bytes = randomBytes(array.byteLength)
  new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(bytes)
  return array
}

export const randomUUID = typeof globalThis.crypto?.randomUUID === 'function'
  ? globalThis.crypto.randomUUID.bind(globalThis.crypto)
  : () => {
      const bytes = getRandomValues(new Uint8Array(16))
      bytes[6] = (bytes[6] & 0x0f) | 0x40
      bytes[8] = (bytes[8] & 0x3f) | 0x80
      const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    }
export const subtle = globalThis.crypto?.subtle

export default { ...crypto, hash, timingSafeEqual, getRandomValues, randomUUID, subtle }
