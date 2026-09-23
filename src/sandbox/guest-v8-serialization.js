import {Buffer} from 'node:buffer'
// V8 format 15, scalar values, objects and arrays. Other tags fail explicitly.
// Wire tags: https://github.com/v8/v8/blob/main/src/objects/value-serializer.cc
const invalid=()=>{throw Error('Unsupported or invalid V8 serialization')}
export function serialize(value){
  const parts=[Buffer.from([255,15])],seen=new Map();let size=2
  const put=bytes=>{size+=bytes.length;if(size>16*1024*1024)throw RangeError('Serialized value exceeds 16 MiB');parts.push(bytes)}
  const tag=char=>put(Buffer.from([char.charCodeAt(0)]))
  const uint=n=>{const bytes=[];do{const byte=n%128;n=Math.floor(n/128);bytes.push(byte+(n?128:0))}while(n);put(Buffer.from(bytes))}
  function write(value,depth=0){
    if(depth>256)throw RangeError('Serialization nesting limit exceeded')
    if(value===undefined)return tag('_')
    if(value===null)return tag('0')
    if(typeof value==='boolean')return tag(value?'T':'F')
    if(typeof value==='number'){tag('N');const bytes=Buffer.alloc(8);bytes.writeDoubleLE(value);return put(bytes)}
    if(typeof value==='string'){const bytes=Buffer.from(value,'utf16le');tag('c');uint(bytes.length);return put(bytes)}
    if(typeof value!=='object')return invalid()
    if(seen.has(value)){tag('^');return uint(seen.get(value))}
    if(seen.size>=4096)throw RangeError('Serialization object limit exceeded')
    if(!Array.isArray(value)&&Object.prototype.toString.call(value)!=='[object Object]')return invalid()
    seen.set(value,seen.size)
    const array=Array.isArray(value);tag(array?'a':'o');if(array)uint(value.length)
    const keys=Object.keys(value)
    for(const key of keys){write(key,depth+1);write(value[key],depth+1)}
    tag(array?'@':'{');uint(keys.length);if(array)uint(value.length)
  }
  write(value);return Buffer.concat(parts)
}
export function deserialize(input){
  if(!ArrayBuffer.isView(input))throw TypeError('Expected a buffer view')
  const bytes=Buffer.from(input.buffer,input.byteOffset,input.byteLength),refs=[];let offset=0
  if(bytes.length>16*1024*1024)return invalid()
  const byte=()=>{if(offset>=bytes.length)return invalid();return bytes[offset++]}
  const uint=()=>{let n=0,m=1;for(let i=0;i<5;i++){const b=byte();n+=(b&127)*m;if(!(b&128)){if(n>0xffffffff)return invalid();return n}m*=128}return invalid()}
  const raw=n=>{if(offset+n>bytes.length)return invalid();const out=bytes.subarray(offset,offset+n);offset+=n;return out}
  if(byte()!==255||uint()!==15)return invalid()
  function read(depth=0){
    if(depth>256)return invalid()
    let t=byte();while(t===0)t=byte()
    switch(String.fromCharCode(t)){
      case '_':return undefined
      case '0':return null
      case 'T':return true
      case 'F':return false
      case 'I':{const n=uint();return (n>>>1)^-(n&1)}
      case 'U':return uint()
      case 'N':return raw(8).readDoubleLE()
      case '"':return raw(uint()).toString('latin1')
      case 'S':return raw(uint()).toString('utf8')
      case 'c':{const n=uint();if(n%2)return invalid();return raw(n).toString('utf16le')}
      case '^':{const id=uint();if(id>=refs.length)return invalid();return refs[id]}
      case 'o':case 'a':case 'A':{
        const array=t!==111,length=array?uint():0,value=array?[]:{}
        if(length>1000000||refs.length>=4096)return invalid()
        if(array)value.length=length
        refs.push(value)
        if(t===65)for(let i=0;i<length;i++){if(bytes[offset]===45){offset++;continue}value[i]=read(depth+1)}
        const end=t===111?123:t===97?64:36;let count=0
        while(bytes[offset]!==end){
          const key=read(depth+1);if(typeof key!=='string'&&typeof key!=='number')return invalid()
          Object.defineProperty(value,key,{value:read(depth+1),enumerable:true,configurable:true,writable:true});count++
        }
        byte();if(uint()!==count)return invalid();if(array&&uint()!==length)return invalid()
        return value
      }
      default:return invalid()
    }
  }
  return read()
}
