// This source is prefixed with the trusted guest core bundle by builtins.ts.
// Hashing stays in QuickJS. Entropy comes from the browser CSPRNG, as copied bytes.
const Buffer=core.buffer.Buffer,host=globalThis.__webContainerHost
const invalid=(message,code='ERR_OUT_OF_RANGE')=>Object.assign(new RangeError(message),{code})
function length(value,max){if(!Number.isSafeInteger(value)||value<0||value>max)throw invalid('Invalid byte count');return value}
function entropy(size){if(!host.randomBytes)throw Error('Secure randomness is unavailable in this backend');return Uint8Array.from(JSON.parse(host.randomBytes(size)))}
export function randomFillSync(value,offset=0,size){
  if(!ArrayBuffer.isView(value)&&!(value instanceof ArrayBuffer))throw new TypeError('Expected an ArrayBuffer or view')
  const bytes=value instanceof ArrayBuffer?new Uint8Array(value):new Uint8Array(value.buffer,value.byteOffset,value.byteLength)
  length(offset,bytes.length);size??=bytes.length-offset;length(size,bytes.length-offset)
  if(size>1024*1024)throw invalid('Random request exceeds the 1 MiB limit')
  for(let index=0;index<size;index+=65536)bytes.set(entropy(Math.min(65536,size-index)),offset+index)
  return value
}
export function randomBytes(size,callback){
  length(size,1024*1024)
  if(callback!==undefined&&typeof callback!=='function')throw new TypeError('Expected callback')
  const value=randomFillSync(Buffer.alloc(size))
  if(callback){queueMicrotask(()=>callback(null,value));return}
  return value
}
export function randomFill(value,offset,size,callback){
  if(typeof offset==='function'){callback=offset;offset=0;size=undefined}
  else if(typeof size==='function'){callback=size;size=undefined}
  if(typeof callback!=='function')throw new TypeError('Expected callback')
  const filled=randomFillSync(value,offset,size);queueMicrotask(()=>callback(null,filled));return value
}
const typedArrayPrototype=Object.getPrototypeOf(Uint8Array.prototype)
const typedArrayGetters=Object.fromEntries(['buffer','byteOffset','byteLength'].map(name=>[name,Object.getOwnPropertyDescriptor(typedArrayPrototype,name).get]))
const typedArrayTag=Object.getOwnPropertyDescriptor(typedArrayPrototype,Symbol.toStringTag).get
export function getRandomValues(value){
  const tag=typedArrayTag.call(value)
  if(!['Int8Array','Uint8Array','Uint8ClampedArray','Int16Array','Uint16Array','Int32Array','Uint32Array','BigInt64Array','BigUint64Array'].includes(tag))throw Object.assign(new Error('Expected an integer typed array'),{name:'TypeMismatchError',code:17})
  const size=typedArrayGetters.byteLength.call(value)
  if(size>65536)throw Object.assign(new Error('Random array exceeds 65536 bytes'),{name:'QuotaExceededError',code:22})
  // Use intrinsic view bounds, not guest-defined buffer or length getters.
  if(size)randomFillSync(new Uint8Array(typedArrayGetters.buffer.call(value),typedArrayGetters.byteOffset.call(value),size))
  return value
}
export function randomUUID(options){
  if(options!==undefined&&(options===null||typeof options!=='object'||options.disableEntropyCache!==undefined&&typeof options.disableEntropyCache!=='boolean'))throw new TypeError('Invalid UUID options')
  const bytes=randomBytes(16);bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128
  const hex=bytes.toString('hex');return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20)
}
export function randomInt(min,max,callback){
  if(typeof max==='function'){callback=max;max=undefined}
  if(max===undefined){max=min;min=0}
  if(!Number.isSafeInteger(min)||!Number.isSafeInteger(max)||max<=min||max-min>=2**48)throw invalid('Invalid random integer range')
  if(callback!==undefined&&typeof callback!=='function')throw new TypeError('Expected callback')
  const range=max-min,limit=2**48-(2**48%range)
  let value
  do{value=0;for(const byte of randomBytes(6))value=value*256+byte}while(value>=limit)
  value=min+value%range
  if(callback){queueMicrotask(()=>callback(null,value));return}
  return value
}
export function createHash(algorithm,options){
  if(options&&Object.keys(options).length)throw Object.assign(Error('Hash options are not implemented'),{code:'ERR_UNSUPPORTED_OPERATION'})
  return core.createHash(algorithm)
}
export function createHmac(algorithm,key,options){
  if(options&&Object.keys(options).some(key=>key!=='encoding'))throw Object.assign(Error('HMAC options are not implemented'),{code:'ERR_UNSUPPORTED_OPERATION'})
  return core.createHmac(algorithm,typeof key==='string'?Buffer.from(key,options?.encoding):key)
}
export const getHashes=()=>['md5','ripemd160','rmd160','sha1','sha224','sha256','sha384','sha512']
export const hash=(algorithm,data,outputEncoding='hex')=>createHash(algorithm).update(data).digest(outputEncoding==='buffer'?undefined:outputEncoding)
export function timingSafeEqual(a,b){
  if(!host.timingSafeEqual)throw Object.assign(Error('Native byte comparison is unavailable in this backend'),{code:'ERR_UNSUPPORTED_OPERATION'})
  return host.timingSafeEqual(a,b)
}
// Entropy APIs only. SubtleCrypto algorithms and CryptoKey are not implemented.
export const webcrypto={
  getRandomValues(value){
    if(this!==webcrypto)throw Object.assign(new TypeError('Value of this must be Crypto'),{code:'ERR_INVALID_THIS'})
    if(arguments.length===0)throw Object.assign(new TypeError('One argument is required'),{code:'ERR_MISSING_ARGS'})
    return getRandomValues(value)
  },
  randomUUID(){
    if(this!==webcrypto)throw Object.assign(new TypeError('Value of this must be Crypto'),{code:'ERR_INVALID_THIS'})
    return randomUUID()
  },
}
export default {createHash,createHmac,getHashes,hash,randomBytes,randomFill,randomFillSync,randomInt,randomUUID,getRandomValues,timingSafeEqual,webcrypto}
