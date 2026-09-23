const typedNames=['Int8Array','Uint8Array','Uint8ClampedArray','Int16Array','Uint16Array','Int32Array','Uint32Array','Float32Array','Float64Array','BigInt64Array','BigUint64Array','DataView']
const fail=()=>{throw new TypeError('Value cannot be serialized for IPC')}
const sharedByteLength=typeof SharedArrayBuffer==='function'?Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype,'byteLength').get:undefined
const isSharedBuffer=value=>{if(!sharedByteLength)return false;try{sharedByteLength.call(value);return true}catch{return false}}
const sharedId=value=>{if(!Number.isInteger(value)||value<1||value>0xffffffff)return fail();return value}
export function encodeIPC(value,mode='json',extensions){
  if(mode==='json')return JSON.stringify(value)
  if(mode!=='advanced')throw new TypeError('Unknown IPC serialization mode')
  const nodes=[],seen=new Map()
  function encode(value){
    if(value===undefined)return ['undefined']
    if(typeof value==='bigint')return ['bigint',String(value)]
    if(typeof value==='number'&&!Number.isFinite(value))return ['number',String(value)]
    if(Object.is(value,-0))return ['number','-0']
    if(value===null||['string','number','boolean'].includes(typeof value))return ['value',value]
    if(typeof value!=='object')return fail()
    if(seen.has(value))return ['ref',seen.get(value)]
    if(nodes.length>=4096)throw new RangeError('IPC object graph exceeds 4096 nodes')
    const id=nodes.length;seen.set(value,id);nodes.push(null)
    let node
    const port=extensions?.encodePort?.(value)
    const memory=port===undefined?extensions?.encodeWasmMemory?.(value):undefined
    const moduleResource=port===undefined&&memory===undefined?extensions?.encodeWasmModuleResource?.(value):undefined
    const module=port===undefined&&memory===undefined&&moduleResource===undefined?extensions?.encodeWasmModule?.(value):undefined
    if(port!==undefined)node=['port',port]
    else if(memory!==undefined)node=['wasm-memory',sharedId(memory)]
    else if(moduleResource!==undefined)node=['wasm-module-resource',sharedId(moduleResource)]
    else if(module!==undefined){
      if(!(module instanceof ArrayBuffer))return fail()
      node=['wasm-module',encode(module)]
    }
    else if(isSharedBuffer(value)){
      if(!extensions?.encodeSharedBuffer)return fail()
      node=['shared-buffer',sharedId(extensions.encodeSharedBuffer(value))]
    }
    else if(value instanceof ArrayBuffer)node=['buffer',Array.from(new Uint8Array(value))]
    else if(ArrayBuffer.isView(value)){
      const name=value.constructor.name
      if(!typedNames.includes(name)&&name!=='Buffer')return fail()
      if(isSharedBuffer(value.buffer)&&!extensions?.encodeSharedBuffer)return fail()
      // Node's advanced child IPC copies each view independently, while worker
      // structured clone preserves backing-buffer aliases.
      const buffer=extensions?value.buffer:value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength)
      node=['view',name,encode(buffer),extensions?value.byteOffset:0,value.byteLength]
    }else if(value instanceof Date)node=['date',encode(value.getTime())]
    else if(value instanceof RegExp)node=['regexp',value.source,value.flags]
    else if(value instanceof Map)node=['map',Array.from(value,([k,v])=>[encode(k),encode(v)])]
    else if(value instanceof Set)node=['set',Array.from(value,encode)]
    else if(value instanceof Error){
      const name=['Error','EvalError','RangeError','ReferenceError','SyntaxError','TypeError','URIError'].includes(value.name)?value.name:'Error'
      node=['error',name,value.message,value.stack,'cause' in value?encode(value.cause):null]
    }
    else if(Array.isArray(value))node=['array',value.length,Object.keys(value).map(key=>[key,encode(value[key])])]
    else if(Object.prototype.toString.call(value)==='[object Object]')node=['object',Object.keys(value).map(key=>[key,encode(value[key])])]
    else return fail()
    nodes[id]=node;return ['ref',id]
  }
  const root=encode(value)
  return JSON.stringify({root,nodes})
}
export function decodeIPC(text,mode='json',extensions){
  if(mode==='json')return JSON.parse(text)
  if(mode!=='advanced')throw new TypeError('Unknown IPC serialization mode')
  const {root,nodes}=JSON.parse(text),objects=new Map()
  function decode(token){
    switch(token[0]){
      case 'undefined':return undefined
      case 'value':return token[1]
      case 'bigint':return BigInt(token[1])
      case 'number':return token[1]==='-0'?-0:Number(token[1])
      case 'ref':break
      default:return fail()
    }
    const id=token[1];if(objects.has(id))return objects.get(id)
    const n=nodes[id];let value
    switch(n[0]){
      case 'port':if(!extensions?.decodePort)return fail();value=extensions.decodePort(n[1]);break
      case 'wasm-memory':
        if(n.length!==2||!extensions?.decodeWasmMemory)return fail()
        value=extensions.decodeWasmMemory(sharedId(n[1]))
        break
      case 'wasm-module-resource':{
        if(n.length!==2||!extensions?.decodeWasmModuleResource)return fail()
        value=extensions.decodeWasmModuleResource(sharedId(n[1]))
        if(typeof WebAssembly!=='object'||!(value instanceof WebAssembly.Module))return fail()
        break
      }
      case 'wasm-module':{
        if(n.length!==2||!extensions?.decodeWasmModule)return fail()
        const bytes=decode(n[1])
        if(!(bytes instanceof ArrayBuffer))return fail()
        value=extensions.decodeWasmModule(bytes)
        if(typeof WebAssembly!=='object'||!(value instanceof WebAssembly.Module))return fail()
        break
      }
      case 'shared-buffer':
        if(n.length!==2||!extensions?.decodeSharedBuffer)return fail()
        value=extensions.decodeSharedBuffer(sharedId(n[1]))
        if(!isSharedBuffer(value))return fail()
        break
      case 'buffer':value=new Uint8Array(n[1]).buffer;break
      case 'view':{
        const buffer=decode(n[2]),name=n[1]
        if(name==='Buffer'&&globalThis.Buffer)value=globalThis.Buffer.from(buffer,n[3],n[4])
        else{if(!typedNames.includes(name))return fail();const Type=globalThis[name];value=name==='DataView'?new Type(buffer,n[3],n[4]):new Type(buffer,n[3],n[4]/Type.BYTES_PER_ELEMENT)}
        break
      }
      case 'date':value=new Date(decode(n[1]));break
      case 'regexp':value=new RegExp(n[1],n[2]);break
      case 'map':value=new Map();break
      case 'set':value=new Set();break
      case 'array':value=new Array(n[1]);break
      case 'object':value={};break
      case 'error':{
        const constructors={Error,EvalError,RangeError,ReferenceError,SyntaxError,TypeError,URIError}
        const ErrorType=constructors[n[1]]??Error
        value=new ErrorType(n[2]);value.name=n[1];value.stack=n[3];break
      }
      default:return fail()
    }
    objects.set(id,value)
    if(n[0]==='map')for(const [k,v] of n[1])value.set(decode(k),decode(v))
    if(n[0]==='set')for(const v of n[1])value.add(decode(v))
    if(n[0]==='array'||n[0]==='object')for(const [key,v] of n[n[0]==='array'?2:1])Object.defineProperty(value,key,{value:decode(v),writable:true,enumerable:true,configurable:true})
    if(n[0]==='error'&&n[4])value.cause=decode(n[4])
    return value
  }
  return decode(root)
}
