// Browser workers never run inside Node's startup snapshot builder.
import {Buffer} from 'buffer'
import process from 'process/browser'
const trace=(phase:string)=>{
  if(process.env.NATIVE_IPC_TRACE==='1')globalThis.postMessage({type:'native-dev-progress',phase})
}
const tracedRequests=new Set<unknown>()
const traceEnvelope=(value:unknown,direction:'send'|'receive')=>{
  if(process.env.NATIVE_IPC_TRACE!=='1'||!value||typeof value!=='object')return
  const frame=value as Record<string,unknown>
  if(frame.t==='q'){
    if(direction==='send'&&frame.i!==undefined)tracedRequests.add(frame.i)
    trace(`rpc-request:operation=${typeof frame.m==='string'?frame.m:'unknown'}`)
    if(frame.m==='onTaskUpdate'&&Array.isArray(frame.a)&&Array.isArray(frame.a[0])){
      const states=new Set<string>()
      for(const pack of frame.a[0]){
        const state=Array.isArray(pack)&&pack[1]&&typeof pack[1]==='object'?pack[1].state:undefined
        if(state==='pass'||state==='fail'||state==='run'||state==='skip'||state==='todo')states.add(state)
      }
      trace(`rpc-task-states:${[...states].sort().join(',')}`)
    }
  }else if(frame.t==='s'){
    const matched=direction==='receive'&&tracedRequests.delete(frame.i)
    trace(`rpc-response:error=${frame.e!==undefined&&frame.e!==null}:result-type=${typeof frame.r}:matched=${matched}`)
  }
}
export const startupSnapshot={isBuildingSnapshot:()=>false}

const unsupported=()=>{throw Object.assign(new Error('Unsupported V8 serialized value'),{code:'ERR_UNSUPPORTED_OPERATION'})}
const regexpFlags=[['g',1],['i',2],['m',4],['y',8],['u',16],['s',32],['d',128],['v',256]] as const
const viewTypes=[Int8Array,Uint8Array,Uint8ClampedArray,Int16Array,Uint16Array,
  Int32Array,Uint32Array,Float32Array,Float64Array,undefined,undefined,BigInt64Array,BigUint64Array]
/** V8 wire-format values used by the browser runtime's binary RPC channel. */
export function serialize(value:unknown):Buffer{
  trace('v8-serialize-start')
  const bytes:number[]=[255,15]
  const references=new Map<object,number>()
  const integer=(value:number)=>{do{const next=value%128;value=Math.floor(value/128);bytes.push(next|(value?128:0))}while(value)}
  const write=(value:unknown):void=>{
    if(value===undefined){bytes.push(95);return}
    if(value===null){bytes.push(48);return}
    if(typeof value==='boolean'){bytes.push(value?84:70);return}
    if(typeof value==='bigint'){
      const negative=value<0n
      let magnitude=negative?-value:value
      const digits:number[]=[]
      while(magnitude){digits.push(Number(magnitude&255n));magnitude>>=8n}
      while(digits.length%8)digits.push(0)
      bytes.push(90);integer(digits.length*2+(negative?1:0))
      for(const digit of digits)bytes.push(digit)
      return
    }
    if(typeof value==='number'){
      if(Number.isInteger(value)&&value>=-2147483648&&value<=2147483647&&!Object.is(value,-0)){
        bytes.push(73);integer(value<0?-value*2-1:value*2)
      }else{bytes.push(78);const data=new Uint8Array(8);new DataView(data.buffer).setFloat64(0,value,true);bytes.push(...data)}
      return
    }
    if(typeof value==='string'){
      let latin=true
      for(let index=0;index<value.length;index++)if(value.charCodeAt(index)>255){latin=false;break}
      bytes.push(latin?34:99);integer(value.length*(latin?1:2))
      for(let index=0;index<value.length;index++){
        const unit=value.charCodeAt(index);bytes.push(unit&255)
        if(!latin)bytes.push(unit>>>8)
      }
      return
    }
    if(typeof value!=='object')unsupported()
    const object=value as object
    if(references.has(object)){bytes.push(94);integer(references.get(object)!);return}
    references.set(object,references.size)
    if(value instanceof ArrayBuffer){
      bytes.push(66);integer(value.byteLength)
      for(const byte of new Uint8Array(value))bytes.push(byte)
      return
    }
    if(value instanceof RegExp){
      bytes.push(82);write(value.source)
      integer(regexpFlags.reduce((bits,[flag,bit])=>bits|(value.flags.includes(flag)?bit:0),0))
      return
    }
    if(value instanceof Date){
      bytes.push(68)
      const data=new Uint8Array(8);new DataView(data.buffer).setFloat64(0,value.getTime(),true)
      bytes.push(...data);return
    }
    if(value instanceof Map){
      bytes.push(59)
      for(const [key,item] of value){write(key);write(item)}
      bytes.push(58);integer(value.size*2);return
    }
    if(value instanceof Set){
      bytes.push(39)
      for(const item of value)write(item)
      bytes.push(44);integer(value.size);return
    }
    if(ArrayBuffer.isView(value)){
      const type=Buffer.isBuffer(value)?10:value instanceof DataView?9:viewTypes.findIndex(Type=>Type&&value instanceof Type)
      if(type<0)unsupported()
      bytes.push(92);integer(type);integer(value.byteLength)
      for(const byte of new Uint8Array(value.buffer,value.byteOffset,value.byteLength))bytes.push(byte)
      return
    }
    if(Array.isArray(value)){
      if(Object.keys(value).length!==value.length)unsupported()
      bytes.push(65);integer(value.length)
      for(const item of value)write(item)
      bytes.push(36);integer(0);integer(value.length);return
    }
    if(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)unsupported()
    bytes.push(111)
    const entries=Object.entries(value as Record<string,unknown>)
    for(const [key,item] of entries){write(key);write(item)}
    bytes.push(123);integer(entries.length)
  }
  write(value)
  traceEnvelope(value,'send')
  trace(`v8-serialize-end:bytes=${bytes.length}`)
  return Buffer.from(bytes)
}

export function deserialize(input:Uint8Array):unknown{
  trace(`v8-deserialize-start:bytes=${input.byteLength}`)
  const bytes=new Uint8Array(input.buffer,input.byteOffset,input.byteLength)
  let offset=0
  const references:unknown[]=[]
  const byte=()=>{if(offset>=bytes.length)throw new Error('Truncated V8 serialized value');return bytes[offset++]!}
  const integer=()=>{let value=0,factor=1;for(let n=0;n<5;n++){const part=byte();value+=(part&127)*factor;if(!(part&128))return value;factor*=128}throw new Error('Invalid V8 integer')}
  const take=(length:number)=>{if(length>bytes.length-offset)throw new Error('Truncated V8 serialized value');const result=bytes.subarray(offset,offset+length);offset+=length;return result}
  const read=():unknown=>{
    let tag=byte();while(tag===0)tag=byte()
    switch(tag){
      case 95:return undefined
      case 48:return null
      case 84:return true
      case 70:return false
      case 73:{const value=integer();return value%2?-(value+1)/2:value/2}
      case 85:return integer()
      case 90:{
        const bits=integer(),data=take(Math.floor(bits/2))
        let value=0n
        for(let index=data.length-1;index>=0;index--)value=(value<<8n)|BigInt(data[index]!)
        return bits%2?-value:value
      }
      case 78:{const data=take(8);return new DataView(data.buffer,data.byteOffset,8).getFloat64(0,true)}
      case 83:return new TextDecoder().decode(take(integer()))
      case 34:return Array.from(take(integer()),value=>String.fromCharCode(value)).join('')
      case 99:{
        const data=take(integer());if(data.length%2)throw new Error('Invalid V8 UTF-16 string')
        let value=''
        for(let index=0;index<data.length;index+=2)value+=String.fromCharCode(data[index]!|data[index+1]!<<8)
        return value
      }
      case 94:{const id=integer();if(id>=references.length)throw new Error('Invalid V8 reference');return references[id]}
      case 66:{const value=new Uint8Array(take(integer())).buffer;references.push(value);return value}
      case 82:{
        const source=read(),bits=integer()
        if(typeof source!=='string'||(bits&~447))throw Error('Invalid V8 RegExp')
        const value=new RegExp(source,regexpFlags.filter(([,bit])=>bits&bit).map(([flag])=>flag).join(''))
        references.push(value);return value
      }
      case 68:{const data=take(8);const value=new Date(new DataView(data.buffer,data.byteOffset,8).getFloat64(0,true));references.push(value);return value}
      case 59:{
        const value=new Map();references.push(value);let count=0
        while(bytes[offset]!==58){const key=read();value.set(key,read());count+=2}
        byte();if(integer()!==count)throw Error('Invalid V8 map count');return value
      }
      case 39:{
        const value=new Set();references.push(value);let count=0
        while(bytes[offset]!==44){value.add(read());count++}
        byte();if(integer()!==count)throw Error('Invalid V8 set count');return value
      }
      case 92:{
        const type=integer(),data=take(integer())
        let value:ArrayBufferView
        if(type===10)value=Buffer.from(data)
        else if(type===9)value=new DataView(new Uint8Array(data).buffer)
        else{
          const Type=viewTypes[type]
          if(!Type)unsupported()
          const copy=new Uint8Array(data).buffer
          if(data.byteLength%Type!.BYTES_PER_ELEMENT)throw Error('Invalid V8 typed array length')
          value=new Type!(copy)
        }
        references.push(value);return value
      }
      case 111:{
        const value:Record<string,unknown>={};references.push(value);let count=0
        while(bytes[offset]!==123){const key=read();if(typeof key!=='string'&&typeof key!=='number')throw new Error('Invalid V8 property');Object.defineProperty(value,key,{value:read(),enumerable:true,writable:true,configurable:true});count++}
        byte();if(integer()!==count)throw new Error('Invalid V8 property count');return value
      }
      case 65:{
        const length=integer();if(length>bytes.length-offset)throw new Error('Invalid V8 array length')
        const value:unknown[]=[];references.push(value)
        for(let i=0;i<length;i++)value.push(read())
        if(byte()!==36||integer()!==0||integer()!==length)unsupported()
        return value
      }
      default:return unsupported()
    }
  }
  if(byte()!==255||integer()!==15)unsupported()
  const result=read()
  trace(`v8-deserialize-end:consumed=${offset}`)
  traceEnvelope(result,'receive')
  return result
}
export default {startupSnapshot,serialize,deserialize}
