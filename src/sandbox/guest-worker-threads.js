import {EventEmitter} from 'node:events'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {Readable} from 'node:stream'
import {Buffer} from 'node:buffer'

const host=globalThis.__webContainerHost
const encoder=new TextEncoder()
const decoder=new TextDecoder()
const unsupported=feature=>Object.assign(Error(feature+' is not implemented in this sandbox'),{code:'ERR_UNSUPPORTED_OPERATION'})
const abortError=reason=>Object.assign(Error('The operation was aborted'),{name:'AbortError',code:'ABORT_ERR',cause:reason})
export const SHARE_ENV=Symbol.for('nodejs.worker_threads.SHARE_ENV')

const routedPorts=createRoutedPorts(host,EventEmitter,prepareMessage,value)
const workerMessageByteLimit=4*1024*1024
function encodeTransferred(value,list){
  const transfers=transferList(list)
  const shared=[],modules=[];let finished=false
  const rollback=()=>{if(finished)return;finished=true;try{if(shared.length)host.shared.release(shared)}finally{if(modules.length)host.moduleResources.release(modules)}}
  try{
  const text=encodeIPC(value,'advanced',{...(host.wasmModule?{...(host.moduleResources?{encodeWasmModuleResource:module=>{
    if(!host.wasmModule.isModule(module))return undefined
    const id=host.moduleResources.retain(host.wasmModule.handle(module));modules.push(id);return id
  }}:{}),encodeWasmModule:module=>host.wasmModule.isModule(module)?host.wasmModule.bytes(module):undefined}:{}),...(host.shared?{encodeSharedBuffer:buffer=>{const id=host.shared.retain(buffer);shared.push(id);return id},encodeWasmMemory:memory=>{
    if(!host.shared.wasmMemory?.isMemory(memory))return undefined
    const id=host.shared.retainMemory(host.shared.wasmMemory.unwrap(memory));shared.push(id);return id
  }}:{}),encodePort:port=>{
    if(!routedPorts.isPort(port))return undefined
    if(!transfers.includes(port))throw cloneError('MessagePort must be listed in transferList')
    return routedPorts.transferId(port)
  }})
  transferList(transfers)
  return {text,shared,modules,ports:transfers.filter(routedPorts.isPort).map(routedPorts.transferId),rollback,commit:()=>{finished=true;detachTransferred(transfers)}}
  }catch(error){rollback();throw error}
}
function prepareMessage(value,list){
  const prepared=encodeTransferred(value,list)
  try{
  const result=encoder.encode(prepared.text)
  if(result.byteLength>workerMessageByteLimit)throw Object.assign(Error('Worker message exceeds the byte limit'),{code:'ERR_RESOURCE_LIMIT'})
  return {...prepared,bytes:result}
  }catch(error){prepared.rollback();throw error}
}
function decodeValue(text,delivery){return decodeIPC(text,'advanced',{decodePort:routedPorts.adopt,...(host.wasmModule?{decodeWasmModule:bytes=>host.wasmModule.fromBytes(bytes),...(host.moduleResources?{decodeWasmModuleResource:id=>host.wasmModule.fromBytes(host.moduleResources.adopt(delivery.scope,delivery.endpoint,delivery.token,id))}:{})}:{}),...(host.shared?{decodeSharedBuffer:id=>host.shared.adopt(delivery.scope,delivery.endpoint,delivery.token,id),...(host.shared.wasmMemory?{decodeWasmMemory:id=>host.shared.wasmMemory.wrap(host.shared.adopt(delivery.scope,delivery.endpoint,delivery.token,id))}:{})}:{})})}
function value(bytes,delivery){return decodeValue(decoder.decode(new Uint8Array(bytes)),delivery)}
function initialWorkerData(){
  if(!host.worker)return null
  try{return decodeValue(host.worker.data,{scope:'data',endpoint:0,token:0})}
  finally{if(host.shared)host.shared.finishWorkerData();else host.moduleResources?.finishWorkerData?.()}
}
const transferBuffer=ArrayBuffer.prototype.transfer
const sliceBuffer=ArrayBuffer.prototype.slice
const cloneError=message=>Object.assign(Error(message),{name:'DataCloneError',code:25})
function transferList(list=[]){
  if(!Array.isArray(list))throw new TypeError('Worker transferList must be an array')
  if(list.length>256)throw unsupported('Worker transfer lists above 256 entries')
  const seen=new Set()
  for(const buffer of list){
    if(seen.has(buffer))throw cloneError('Transfer list contains a duplicate object')
    if(routedPorts.isPort(buffer)){routedPorts.transferId(buffer);seen.add(buffer);continue}
    if(!(buffer instanceof ArrayBuffer))throw unsupported('Only ArrayBuffer transfers are implemented')
    if(buffer.resizable)throw unsupported('Resizable ArrayBuffer transfers')
    if(typeof transferBuffer!=='function')throw unsupported('ArrayBuffer detachment in this engine')
    if(seen.has(buffer))throw cloneError('Transfer list contains a duplicate ArrayBuffer')
    try{sliceBuffer.call(buffer,0,0)}catch{throw cloneError('Cannot transfer a detached ArrayBuffer')}
    seen.add(buffer)
  }
  return [...seen]
}
function detachTransferred(buffers){for(const buffer of buffers)routedPorts.isPort(buffer)?routedPorts.detach(buffer):transferBuffer.call(buffer,0)}
function workerOptions(options={}){
  if(options===null||typeof options!=='object'||Array.isArray(options))throw new TypeError('Worker options must be an object')
  const supported=new Set(['argv','env','execArgv','workerData','stdin','stdout','stderr','trackUnmanagedFds','resourceLimits','name','eval','signal','transferList'])
  for(const key of Object.keys(options))if(!supported.has(key))throw unsupported('Worker option '+key)
  if(options.eval!==undefined&&typeof options.eval!=='boolean')throw new TypeError('Worker eval must be a boolean')
  if(options.stdin)throw unsupported('Worker stdin stream')
  for(const name of ['stdout','stderr'])if(options[name]!==undefined&&typeof options[name]!=='boolean')throw new TypeError('Worker '+name+' must be a boolean')
  if(options.trackUnmanagedFds===false)throw unsupported('Worker trackUnmanagedFds=false')
  if(options.name!==undefined&&typeof options.name!=='string')throw new TypeError('Worker name must be a string')
  if(options.resourceLimits!==undefined){
    if(options.resourceLimits===null||typeof options.resourceLimits!=='object'||Array.isArray(options.resourceLimits))throw new TypeError('Worker resourceLimits must be an object')
    if(Object.keys(options.resourceLimits).length)throw unsupported('Worker resourceLimits')
  }
  if(options.argv!==undefined&&(!Array.isArray(options.argv)||options.argv.some(entry=>typeof entry!=='string')))throw new TypeError('Worker argv must be an array of strings')
  if(options.execArgv!==undefined&&(!Array.isArray(options.execArgv)||options.execArgv.some(entry=>typeof entry!=='string')))throw new TypeError('Worker execArgv must be an array of strings')
  if(options.eval){
    if(options.execArgv?.length!==1||!['--input-type=commonjs','--input-type=module'].includes(options.execArgv[0]))throw unsupported('Eval workers require an explicit --input-type=commonjs or --input-type=module')
  }else if(options.execArgv?.length)throw unsupported('Worker execArgv')
  if(options.env===SHARE_ENV)throw unsupported('Worker SHARE_ENV')
  if(options.env!==undefined&&(options.env===null||typeof options.env!=='object'||Array.isArray(options.env)))throw new TypeError('Worker env must be an object')
  if(options.signal!==undefined&&typeof options.signal?.addEventListener!=='function')throw new TypeError('Expected AbortSignal')
  return {eval:options.eval===true,stdout:options.stdout===true,stderr:options.stderr===true,argv:options.argv??[],execArgv:options.execArgv??[],env:options.env??process.env,workerData:Object.hasOwn(options,'workerData')?options.workerData:null,signal:options.signal}
}

class TransportPort extends EventEmitter {
  constructor(pid,parentSide=false){super();this.pid=pid;this._parentSide=parentSide;this._active=false;this._closed=false;this._referenced=false;this._pending=[];this._done=Promise.resolve()}
  postMessage(message,transfer){
    if(this._closed)throw Object.assign(Error('MessagePort is closed'),{code:'ERR_WORKER_NOT_RUNNING'})
    const prepared=prepareMessage(message,transfer)
    try{
      if(host.proc.workerSend)host.proc.workerSend(this.pid,prepared.bytes,prepared.ports,prepared.shared,prepared.modules)
      else host.proc.call('workerSend',this.pid,Array.from(prepared.bytes),prepared.ports,prepared.shared,prepared.modules)
      prepared.commit()
    }
    catch(error){prepared.rollback();throw error}
  }
  start(){
    if(!this._active&&!this._closed){this._active=true;this._done=this._pump().catch(error=>host.reportError(error))}
    return this
  }
  ref(){this._referenced=true;if(this._parentSide)host.proc.call('workerPortRef',true);return this}
  unref(){this._referenced=false;if(this._parentSide)host.proc.call('workerPortRef',false);return this}
  close(){
    if(this._closed)return
    this._closed=true;this._referenced=false;if(this._parentSide)host.proc.call('workerPortRef',false)
    try{host.proc.call('workerClose',this.pid)}catch{}
    this.emit('close')
  }
  on(name,listener){super.on(name,listener);if(name==='message'){this.start();this.ref();this._flush()}return this}
  once(name,listener){super.once(name,listener);if(name==='message'){this.start();this.ref();this._flush()}return this}
  off(name,listener){EventEmitter.prototype.removeListener.call(this,name,listener);if(name==='message'&&!this.listenerCount('message'))this.unref();return this}
  removeListener(name,listener){return this.off(name,listener)}
  removeAllListeners(name){super.removeAllListeners(name);if(name===undefined||name==='message')this.unref();return this}
  _flush(){while(this._pending.length&&this.listenerCount('message'))this.emit('message',this._pending.shift())}
  async _pump(){
    while(!this._closed){
      const payload=await host.proc.workerNext(this.pid)
      if(payload===null)break
      if(this._closed)break
      let message
      try{message=value(payload.bytes,{scope:'worker',endpoint:this.pid,token:payload.token})}finally{host.proc.call('workerAck',this.pid,payload.token)}
      if(this.listenerCount('message'))globalThis[Symbol.for('web-container:task-queue')].task(this.emit,this,['message',message])
      else{
        if(this._pending.length>=256)throw Object.assign(Error('Worker message queue exceeded'),{code:'ERR_RESOURCE_LIMIT'})
        this._pending.push(message)
      }
    }
    if(!this._closed){this._closed=true;globalThis[Symbol.for('web-container:task-queue')].task(this.emit,this,['close'])}
  }
}

export const isMainThread=!host.worker
export const threadId=host.worker?.threadId??0
export const workerData=initialWorkerData()
export const parentPort=host.worker?new TransportPort(host.worker.threadId,true):null

function workerFilename(filename,evalMode){
  let dataURL=false
  if(filename instanceof URL){
    if(evalMode)throw Object.assign(new TypeError('Eval worker source must be a string'),{code:'ERR_INVALID_ARG_VALUE'})
    dataURL=filename.protocol==='data:'
    filename=dataURL?filename.href:fileURLToPath(filename)
  }
  if(typeof filename!=='string')throw Object.assign(new TypeError('Worker filename must be a string or URL'),{code:'ERR_INVALID_ARG_TYPE'})
  if(!evalMode&&!dataURL&&!filename.startsWith('/')&&!filename.startsWith('./')&&!filename.startsWith('../'))throw Object.assign(new TypeError('Worker filename must be an absolute path or start with ./ or ../'),{code:'ERR_WORKER_PATH'})
  if(filename.includes('\0'))throw new TypeError('Worker filename or source must not contain a null byte')
  return {filename,dataURL}
}

export class Worker extends EventEmitter {
  constructor(filename,options={}){
    super()
    const settings=workerOptions(options)
    const normalized=workerFilename(filename,settings.eval),dataURL=normalized.dataURL
    filename=normalized.filename
    const prepared=encodeTransferred(settings.workerData,options.transferList)
    this.threadId=-1;this._closed=false;this._terminated=false;this._online=false;this._messages=[]
    this._exit=new Promise(resolve=>this._resolveExit=resolve)
    const output=()=>new Readable({
      read(){const resume=this._resumePipe;this._resumePipe=undefined;resume?.()},
      destroy(error,done){const resume=this._resumePipe;this._resumePipe=undefined;resume?.();done(error)}
    })
    this.stdout=settings.stdout?output():null
    this.stderr=settings.stderr?output():null
    try{
      this.threadId=host.proc.call('workerSpawn',filename,{ports:prepared.ports,shared:prepared.shared,modules:prepared.modules,dataURL,eval:settings.eval,stdout:settings.stdout,stderr:settings.stderr,argv:settings.argv,execArgv:settings.execArgv,env:settings.env},prepared.text)
      prepared.commit()
    }catch(error){prepared.rollback();throw error}
    this._port=new TransportPort(this.threadId)
    // Start message delivery after online, rather than consuming messages into
    // a pre-online array and later emitting that array in one synchronous turn.
    if(settings.signal){
      this._signal=settings.signal
      this._abort=()=>{this.emit('error',abortError(settings.signal.reason));void this.terminate()}
      settings.signal.addEventListener('abort',this._abort,{once:true})
    }
    process.nextTick(()=>{if(settings.signal?.aborted)this._abort();this._pump().catch(error=>host.reportError(error))})
  }
  postMessage(message,transfer){transferList(transfer);if(this.threadId<0)throw Object.assign(Error('Worker is not running'),{code:'ERR_WORKER_NOT_RUNNING'});this._port.postMessage(message,transfer)}
  on(name,listener){super.on(name,listener);if(name==='message')this._flushMessages();return this}
  once(name,listener){super.once(name,listener);if(name==='message')this._flushMessages();return this}
  _deliverMessage(message){
    if(this._online&&this.listenerCount('message'))this.emit('message',message)
    else{
      if(this._messages.length>=256)throw Object.assign(Error('Worker message queue exceeded'),{code:'ERR_RESOURCE_LIMIT'})
      this._messages.push(message)
    }
  }
  _flushMessages(){while(this._online&&this._messages.length&&this.listenerCount('message'))this.emit('message',this._messages.shift())}
  ref(){if(this.threadId>=0)host.proc.call('ref',this.threadId,true)}
  unref(){if(this.threadId>=0)host.proc.call('ref',this.threadId,false)}
  terminate(){
    if(this.threadId<0)return this._exit
    this._terminated=true;host.proc.call('kill',this.threadId,'SIGTERM')
    for(const stream of [this.stdout,this.stderr]){const resume=stream?._resumePipe;if(stream)stream._resumePipe=undefined;resume?.()}
    return this._exit
  }
  async _pump(){
    const pid=this.threadId
    for(;;){
      const event=await host.proc.next(pid)
      if(!event)return
      if(event.type==='stdout'||event.type==='stderr'){
        const stream=this[event.type]
        if(!stream)throw Error('Received uncaptured worker output')
        if(!stream.destroyed&&!stream.push(Buffer.from(event.bytes))&&!this._terminated)
          await new Promise(resolve=>stream._resumePipe=resolve)
        continue
      }
      if(event.type==='online'){this._online=true;globalThis[Symbol.for('web-container:task-queue')].task(this.emit,this,['online']);this._port.on('message',message=>this._deliverMessage(message));this._port.unref();this._flushMessages();continue}
      if(event.type==='error'){
        const details=JSON.parse(event.error),error=Error(details.message)
        error.name=details.name;error.stack=details.stack;if(details.code)error.code=details.code
        globalThis[Symbol.for('web-container:task-queue')].task(this.emit,this,['error',error]);continue
      }
      if(event.type==='exit'){
        await this._port._done
        this._closed=true;this._signal?.removeEventListener('abort',this._abort);this._port._closed=true
        const code=event.code??(this._terminated?1:0)
        this.threadId=-1
        this.stdout?.push(null);this.stderr?.push(null)
        try{globalThis[Symbol.for('web-container:task-queue')].task(this.emit,this,['exit',code])}finally{host.proc.call('forget',pid);this._resolveExit(code)}
        return
      }
    }
  }
}
