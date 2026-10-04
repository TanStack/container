import {Buffer} from 'buffer'
import {linkNativeFilesystemWorker} from './filesystem-worker-link.mjs'

const HEADER_BYTES=16,CHUNK_BYTES=10240,WAITING=21,MORE=2,TRANSPORT_ERROR=3
const BINARY_REPLY=10
const PROTOCOL='tanstack-wasi-fs-1'
const encoder=new TextEncoder(),decoder=new TextDecoder()
const encodingFailure=encoder.encode('WASI filesystem reply encoding failed')
const monotonicNow=performance.now.bind(performance)
let filesystemPort

// A compiler thread talks straight to the filesystem owner, not through the
// thread that can be blocked inside a synchronous native compiler call.
export function connectWasiFilesystemPort(port){
  if(filesystemPort)throw new Error('WASI filesystem port already connected')
  if(!port||typeof port.postMessage!=='function'||typeof port.close!=='function')
    throw new TypeError('Invalid WASI filesystem port')
  filesystemPort=port
  return ()=>{if(filesystemPort===port){filesystemPort=undefined;port.close()}}
}

function sendFilesystemRequest(message){
  if(filesystemPort)filesystemPort.postMessage(message)
  else globalThis.postMessage(message)
}

// Structured cloning preserves shared WASM memory but copies ordinary Node
// buffers. Bridge read destinations through shared byte views, then copy the
// completed mutation back. Overlapping vector views must retain their aliases.
function prepareReadBuffers(method,args){
  if(method==='readSync'&&ArrayBuffer.isView(args[1])&&(args.length<=3||typeof args[2]==='object')){
    const options=args[2]
    if(options!==undefined&&options!==null&&(typeof options!=='object'||Array.isArray(options)))
      throw Object.assign(new TypeError('Read options must be an object'),{code:'ERR_INVALID_ARG_TYPE'})
    const offset=options?.offset===undefined?0:options.offset
    const length=options?.length===undefined?args[1].byteLength-offset:options.length
    const position=options?.position===undefined?null:options.position
    // The pinned memfs backend takes the positional form, not Node's options
    // overload. Both forms must reach the same byte-oriented service operation.
    args=[args[0],args[1],offset,length,position]
  }
  const vector=method==='readvSync'&&Array.isArray(args[1])
  if(method!=='readSync'&&!vector)return {payload:args,restore(){}}
  const values=vector?args[1]:[args[1]],byBuffer=new Map(),copies=[]
  const replacements=values.slice()
  for(let index=0;index<values.length;index++){
    const view=values[index]
    if(!ArrayBuffer.isView(view)||view.buffer instanceof SharedArrayBuffer)continue
    let group=byBuffer.get(view.buffer)
    if(!group)byBuffer.set(view.buffer,group=[])
    group.push({view,index,start:view.byteOffset,end:view.byteOffset+view.byteLength})
  }
  if(!byBuffer.size)return {payload:args,restore(){}}
  for(const [buffer,views]of byBuffer){
    views.sort((a,b)=>a.start-b.start)
    const groups=[]
    for(const entry of views){
      const previous=groups.at(-1)
      if(previous&&entry.start<=previous.end){previous.end=Math.max(previous.end,entry.end);previous.views.push(entry)}
      else groups.push({start:entry.start,end:entry.end,views:[entry]})
    }
    for(const group of groups){
      const original=new Uint8Array(buffer,group.start,group.end-group.start)
      const shared=new Uint8Array(new SharedArrayBuffer(original.byteLength));shared.set(original)
      copies.push({original,shared})
      for(const {view,index}of group.views)
        replacements[index]=new Uint8Array(shared.buffer,view.byteOffset-group.start,view.byteLength)
    }
  }
  const payload=args.slice();payload[1]=vector?replacements:replacements[0]
  return {payload,restore(){for(const {original,shared}of copies)original.set(shared)}}
}

function validLane(lane){
  return lane instanceof Int32Array&&lane.buffer instanceof SharedArrayBuffer&&
    lane.byteOffset===0&&lane.byteLength===HEADER_BYTES+CHUNK_BYTES
}
function publish(lane,type,total,bytes,status){
  new Uint8Array(lane.buffer,HEADER_BYTES,CHUNK_BYTES).set(bytes)
  Atomics.store(lane,1,type);Atomics.store(lane,2,total);Atomics.store(lane,3,bytes.length)
  Atomics.store(lane,0,status);Atomics.notify(lane,0)
}
function fail(lane,message){
  const bytes=encoder.encode(message)
  publish(lane,4,bytes.length,bytes,TRANSPORT_ERROR)
}

// Each compiler worker owns one handler. Continuations never re-run fs methods.
export function createWasiFilesystemHost(fs,{getType,encodeValue,onReply}){
  let active,disposed=false
  function encode(value){
    // The older pinned codec has no binary tag and JSON-serializes buffers.
    // Binary replies belong to our transport and use the newer codec's tag.
    // Keep both upstream codecs unchanged for metadata, errors and other values.
    if(Buffer.isBuffer(value))return {type:BINARY_REPLY,bytes:new Uint8Array(value)}
    const type=getType(value)
    return {type,bytes:encodeValue(fs,value,type)}
  }
  function write(lane,reply){
    const end=Math.min(reply.offset+CHUNK_BYTES,reply.bytes.length)
    const bytes=reply.bytes.subarray(reply.offset,end)
    reply.offset=end
    if(end<reply.bytes.length){active=reply;reply.lane=lane}
    else active=undefined
    publish(lane,reply.type,reply.bytes.length,bytes,end<reply.bytes.length?MORE:reply.status)
  }
  function encodeError(error){
    try{
      return encode(error)
    }catch{
      let message='Unserializable thrown value'
      try{message=String(error)}catch{}
      return {type:4,bytes:encoder.encode(message)}
    }
  }
  function onMessage(event){
    const request=event.data?.__fs__
    if(!request)return
    const lane=request.sab
    if(!validLane(lane))throw new TypeError('Invalid WASI filesystem reply lane')
    try{
    if(disposed){fail(lane,'WASI filesystem host disposed');return}
    if(request.protocol!==PROTOCOL||!Number.isSafeInteger(request.id)||request.id<1){
      fail(lane,'Invalid WASI filesystem protocol');return
    }
    if(request.cancel===true){if(active?.id===request.id)active=undefined;return}
    if(request.continue===true){
      if(!active||request.id!==active.id||request.offset!==active.offset){
        fail(lane,'Invalid WASI filesystem continuation');return
      }
      write(lane,active);return
    }
    if(active){fail(lane,'WASI filesystem reply already in progress');return}
    let value,status=0
    try{
      if(typeof request.type!=='string'||!Array.isArray(request.payload)||typeof fs[request.type]!=='function')
        throw new TypeError('Invalid WASI filesystem operation')
      const result=Reflect.apply(fs[request.type],fs,request.payload)
      value=encode(result)
    }catch(error){status=1;value=encodeError(error)}
    if(!(value.bytes instanceof Uint8Array)||value.bytes.length>0x7fffffff){
      fail(lane,'Invalid WASI filesystem encoded reply');return
    }
    if(onReply)try{onReply({method:request.type,reply:status===0?'result':'error',
      encodedBytes:value.bytes.length,chunks:Math.max(1,Math.ceil(value.bytes.length/CHUNK_BYTES)),wireType:value.type})}catch{}
    write(lane,{...value,id:request.id,status,offset:0,lane})
    }catch{
      if(active?.id===request.id)active=undefined
      // Error formatting and fallback string conversion are guest-controlled.
      // A pre-encoded terminal reply must not call either one again.
      publish(lane,4,encodingFailure.length,encodingFailure,TRANSPORT_ERROR)
    }
  }
  onMessage.dispose=()=>{
    if(disposed)return;disposed=true
    const pending=active;active=undefined
    if(pending&&Atomics.load(pending.lane,0)===WAITING)fail(pending.lane,'WASI filesystem host disposed')
  }
  onMessage.inspect=()=>({disposed,pendingBytes:active?.bytes.length??0})
  return onMessage
}

export function createWasiFilesystemClient(memfs,{decodeValue,send=sendFilesystemRequest,wait=Atomics.wait,
  timeoutMs=30000,now=monotonicNow}){
  if(typeof timeoutMs!=='number'||!Number.isFinite(timeoutMs)||timeoutMs<=0)
    throw new RangeError('WASI filesystem timeout must be a positive finite number')
  if(typeof now!=='function')throw new TypeError('Invalid WASI filesystem clock')
  let next=0
  return new Proxy({}, {get(_target,method){return function(...args){
    if(typeof method!=='string')throw new TypeError('Invalid WASI filesystem operation')
    const {payload,restore}=prepareReadBuffers(method,args)
    const id=next=next===Number.MAX_SAFE_INTEGER?1:next+1
    const lane=new Int32Array(new SharedArrayBuffer(HEADER_BYTES+CHUNK_BYTES))
    const deadline=now()+timeoutMs
    const timedOut=()=>Object.assign(new Error('WASI filesystem request timed out'),{code:'ERR_WASI_FILESYSTEM_TIMEOUT'})
    let bytes,type,total,offset=0
    Atomics.store(lane,0,WAITING)
    try{
    send({__fs__:{protocol:PROTOCOL,id,sab:lane,type:method,payload}})
    while(true){
      while(Atomics.load(lane,0)===WAITING){
        const remaining=deadline-now()
        if(!Number.isFinite(remaining)||remaining<=0)throw timedOut()
        const result=wait(lane,0,WAITING,remaining)
        // A wakeup is not a reply. A reply published as the wait expires still
        // wins, but notifications and chunk boundaries never reset the clock.
        if(result==='timed-out'&&Atomics.load(lane,0)===WAITING)throw timedOut()
      }
      const status=Atomics.load(lane,0),replyType=Atomics.load(lane,1),replyTotal=Atomics.load(lane,2),size=Atomics.load(lane,3)
      if(![0,1,MORE,TRANSPORT_ERROR].includes(status)||size<0||size>CHUNK_BYTES||replyTotal<0)
        throw new Error('Invalid WASI filesystem reply header')
      const chunk=new Uint8Array(lane.buffer,HEADER_BYTES,size)
      if(status===TRANSPORT_ERROR)throw new Error(decoder.decode(chunk.slice()))
      if(bytes===undefined){type=replyType;total=replyTotal;bytes=new Uint8Array(total)}
      if(replyType!==type||replyTotal!==total||offset+size>total||
        status===MORE&&(size===0||offset+size>=total)||status!==MORE&&offset+size!==total)
        throw new Error('Invalid WASI filesystem reply sequence')
      bytes.set(chunk,offset);offset+=size
      if(status!==MORE){
        restore()
        const value=type===BINARY_REPLY?Buffer.from(bytes):decodeValue(memfs,bytes,type)
        if(status===1)throw value
        // The pinned JSON codecs restore Stats methods but serialize Date
        // fields as strings. Rebuild those fields from the numeric timestamps
        // at the RPC boundary, for Node callers and native compiler callers.
        if(value!==undefined&&['statSync','lstatSync','fstatSync'].includes(method))
          for(const name of ['atime','mtime','ctime','birthtime'])
            value[name]=new Date(Number(value[name+'Ms']))
        return value
      }
      Atomics.store(lane,0,WAITING)
      send({__fs__:{protocol:PROTOCOL,id,sab:lane,continue:true,offset}})
    }
    }catch(error){
      try{send({__fs__:{protocol:PROTOCOL,id,sab:lane,cancel:true}})}catch{}
      throw error
    }
  }}})
}

// This is local ownership of a compiler-created worker, not a global Worker patch.
export function manageWasiFilesystemWorker(worker,handler){
  const link=linkNativeFilesystemWorker(worker)
  if(link){
    // This worker now talks directly to the storage owner. Do not attach the
    // parent-side request handler, the parent may block inside a compiler call.
    handler.dispose()
    const terminate=worker.terminate
    worker.addEventListener('error',()=>link.dispose(),{once:true})
    Object.defineProperty(worker,'terminate',{configurable:true,writable:true,value:function(...args){
      if(this===worker)link.dispose()
      return Reflect.apply(terminate,this,args)
    }})
    return
  }
  const terminate=worker.terminate
  const onError=()=>handler.dispose()
  worker.addEventListener('message',handler);worker.addEventListener('error',onError)
  Object.defineProperty(worker,'terminate',{configurable:true,writable:true,value:function(...args){
    if(this===worker){
      handler.dispose();worker.removeEventListener('message',handler);worker.removeEventListener('error',onError)
    }
    return Reflect.apply(terminate,this,args)
  }})
}

export function traceWasiFilesystemReply(row){
  if(row.encodedBytes<=CHUNK_BYTES)return
  try{globalThis.postMessage({type:'native-dev-progress',phase:'wasi-fs-reply:'+JSON.stringify(row)})}catch{}
}
