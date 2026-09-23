import {Duplex} from 'node:stream'
import {EventEmitter} from 'node:events'
import {Buffer} from 'node:buffer'
import process from 'node:process'

const fail=(code,message=code)=>Object.assign(Error(message),{code})
const transport=()=>{const net=globalThis.__webContainerHost.net;if(!net)throw fail('ERR_UNSUPPORTED_OPERATION','Virtual sockets require the worker-owned kernel');return net}
function options(args){
  const callback=typeof args.at(-1)==='function'?args.pop():undefined
  const first=args[0]
  const value=first&&typeof first==='object'?first:{port:first,host:typeof args[1]==='string'?args[1]:undefined}
  if(value.path!==undefined||typeof value.port==='string'&&!/^\d+$/.test(value.port))throw fail('ERR_UNSUPPORTED_OPERATION','Unix socket paths are not implemented')
  const port=Number(value.port??0)
  if(!Number.isInteger(port)||port<0||port>65535)throw fail('ERR_SOCKET_BAD_PORT')
  return {port,host:value.host??'127.0.0.1',callback,value}
}

export class Socket extends Duplex {
  constructor(settings={}){
    if(settings.fd!==undefined)throw fail('ERR_UNSUPPORTED_OPERATION','Host file descriptors are unavailable')
    super({...settings,allowHalfOpen:settings.allowHalfOpen??false,autoDestroy:true,emitClose:false})
    this.connecting=false;this.pending=true;this.bytesRead=0;this.bytesWritten=0;this._referenced=true
    // Read the transport until the stream's high-water mark, even before a data
    // listener exists, so a FIN can complete a write-only response socket.
    this._wantRead=true
    this._ready=new Promise((resolve,reject)=>{this._resolveReady=resolve;this._rejectReady=reject});this._ready.catch(()=>{})
  }
  _attach(value){
    this._id=value.id;this.localAddress=this.remoteAddress='127.0.0.1';this.localFamily=this.remoteFamily='IPv4'
    this.localPort=value.port;this.remotePort=value.remotePort;this.connecting=false;this.pending=false
    transport().call('ref',this._id,this._referenced);this._resolveReady();this._activity()
    if(this._wantRead)this._pump()
  }
  connect(...args){
    if(this._id!==undefined||this.connecting)throw fail('ERR_SOCKET_ALREADY_BOUND')
    const {port,host,callback}=options(args)
    if(callback)this.once('connect',callback)
    this.connecting=true
    process.nextTick(()=>{
      if(this.destroyed)return
      try{this._attach(transport().call('connect',port,host));this.emit('connect');this.emit('ready')}
      catch(error){this.connecting=false;this._rejectReady(error);this.destroy(error)}
    })
    return this
  }
  _read(){this._wantRead=true;this._pump()}
  _pump(){
    if(this._reading||this._id===undefined||this.destroyed||!this._wantRead)return
    this._reading=true
    transport().next(this._id).then(event=>globalThis[Symbol.for('web-container:task-queue')].task(()=>{
      this._reading=false
      if(this.destroyed)return
      if(event?.type==='data'){
        const bytes=Buffer.from(event.bytes);this.bytesRead+=bytes.length;this._activity()
        this._wantRead=this.push(bytes)
        if(this._wantRead)this._pump()
      }else if(event?.type==='end'){this._wantRead=false;this.push(null);this.read(0)}
      else if(event?.type==='error')this.destroy(fail(event.code))
      else this.destroy()
    }),error=>globalThis[Symbol.for('web-container:task-queue')].task(()=>{this._reading=false;if(!this.destroyed)this.destroy(error)})).catch(error=>globalThis.__webContainerHost.reportError(error))
  }
  _write(chunk,encoding,callback){
    this._ready.then(async()=>{
      if(this.destroyed)throw fail('ERR_STREAM_DESTROYED')
      for(let offset=0;offset<chunk.length;offset+=16384){await transport().write(this._id,chunk.subarray(offset,offset+16384));this.bytesWritten+=Math.min(16384,chunk.length-offset);this._activity()}
    }).then(()=>callback(),callback)
  }
  _final(callback){this._ready.then(()=>transport().call('end',this._id)).then(()=>callback(),callback)}
  _destroy(error,callback){
    clearTimeout(this._timer);this.connecting=false;this.pending=true
    this._rejectReady(error??fail('ERR_STREAM_DESTROYED'))
    if(this._id!==undefined){try{transport().call('destroy',this._id)}catch{}this._id=undefined}
    callback(error)
    process.nextTick(()=>this.emit('close',!!error))
  }
  address(){return this._id===undefined?{}:{address:this.localAddress,family:this.localFamily,port:this.localPort}}
  ref(){this._referenced=true;if(this._id!==undefined)transport().call('ref',this._id,true);return this}
  unref(){this._referenced=false;if(this._id!==undefined)transport().call('ref',this._id,false);return this}
  setTimeout(ms,callback){
    if(!Number.isFinite(ms)||ms<0)throw fail('ERR_OUT_OF_RANGE')
    this.timeout=ms;if(callback)this.once('timeout',callback);this._activity();return this
  }
  _activity(){clearTimeout(this._timer);if(this.timeout>0&&!this.destroyed){this._timer=setTimeout(()=>this.emit('timeout'),this.timeout);this._timer.unref?.()}}
  // This transport delivers immediately and has no packet coalescing or OS keepalive.
  setNoDelay(){return this}
  setKeepAlive(){return this}
  destroySoon(){if(this.writableFinished)this.destroy();else {this.once('finish',()=>this.destroy());this.end()}}
  resetAndDestroy(){return this.destroy(fail('ECONNRESET'))}
  get bufferSize(){return this.writableLength}
  get readyState(){return this.connecting?'opening':this.destroyed?'closed':this.readable&&this.writable?'open':this.readable?'readOnly':this.writable?'writeOnly':'closed'}
}

export class Server extends EventEmitter {
  constructor(settings={},listener){
    super();if(typeof settings==='function'){listener=settings;settings={}}
    this._settings=settings;this.listening=false;this._referenced=true
    if(listener)this.on('connection',listener)
  }
  listen(...args){
    if(this._id!==undefined)throw fail('ERR_SERVER_ALREADY_LISTEN')
    const {port,host,callback}=options(args)
    if(callback)this.once('listening',callback)
    try{
      const shareKey=process.env.NODE_UNIQUE_ID===undefined?undefined:'cluster:'+process.ppid
      const value=transport().call('listen',port,host,shareKey);this._id=value.id;this._port=value.port;this.listening=true
      if(shareKey)globalThis.__webContainerClusterServer?.(this)
      transport().call('ref',this._id,this._referenced)
      process.nextTick(()=>{if(this.listening){const address=this.address();globalThis.__webContainerClusterListening?.(address);this.emit('listening')}this._accept()})
    }catch(error){process.nextTick(()=>this.emit('error',error))}
    return this
  }
  _accept(){
    if(this._id===undefined)return
    transport().next(this._id).then(event=>globalThis[Symbol.for('web-container:task-queue')].task(()=>{
      if(event?.type==='connection'){
        const socket=new Socket(this._settings);socket.server=this;socket._attach(event)
        if(this.maxConnections!==undefined&&transport().call('connections',this._id)>this.maxConnections)socket.destroy()
        else this.emit('connection',socket)
        this._accept()
      }else if(event?.type==='close'||event===null){this._id=undefined;this.listening=false;this.emit('close')}
    }),error=>globalThis[Symbol.for('web-container:task-queue')].task(this.emit,this,['error',error])).catch(error=>globalThis.__webContainerHost.reportError(error))
  }
  close(callback){
    if(this._id===undefined){if(callback)process.nextTick(callback,fail('ERR_SERVER_NOT_RUNNING'));return this}
    if(callback)this.once('close',callback)
    this.listening=false;transport().call('closeServer',this._id);return this
  }
  address(){return !this.listening?null:{address:'127.0.0.1',family:'IPv4',port:this._port}}
  getConnections(callback){process.nextTick(()=>callback(null,this._id===undefined?0:transport().call('connections',this._id)))}
  ref(){this._referenced=true;if(this._id!==undefined)transport().call('ref',this._id,true);return this}
  unref(){this._referenced=false;if(this._id!==undefined)transport().call('ref',this._id,false);return this}
}
export const createServer=(...args)=>new Server(...args)
export const createConnection=(...args)=>new Socket().connect(...args)
export const connect=createConnection
export function isIPv4(value){return typeof value==='string'&&/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)&&value.split('.').every(part=>Number(part)<=255)}
export function isIPv6(value){
  if(typeof value!=='string')return false
  const parts=value.split('%');if(parts.length>2||parts.length===2&&!/^[0-9A-Za-z_.~-]+$/.test(parts[1]))return false
  let address=parts[0]
  if(address.includes('.')){const index=address.lastIndexOf(':');if(!isIPv4(address.slice(index+1)))return false;address=address.slice(0,index)+':0:0'}
  const halves=address.split('::');if(halves.length>2)return false
  const groups=halves.flatMap(part=>part?part.split(':'):[])
  return groups.every(part=>/^[0-9a-fA-F]{1,4}$/.test(part))&&(halves.length===2?groups.length<8:groups.length===8)
}
export const isIP=value=>isIPv4(value)?4:isIPv6(value)?6:0
export default {Socket,Server,createServer,createConnection,connect,isIP,isIPv4,isIPv6}
