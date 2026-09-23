import {Duplex} from 'node:stream'
import {Socket as NetSocket,Server as NetServer} from 'node:net'
import {Buffer} from 'node:buffer'
import process from 'node:process'

const fail=(code,message=code)=>Object.assign(Error(message),{code})
const call=(method,...args)=>{
  const tls=globalThis.__webContainerHost.tls
  if(!tls)throw fail('ERR_UNSUPPORTED_OPERATION','TLS requires the worker-owned kernel')
  return tls.call(method,...args)
}
const contexts=new WeakMap()
const version=value=>{if(value==='TLSv1.2')return 12;if(value==='TLSv1.3')return 13;throw fail('ERR_TLS_INVALID_PROTOCOL_VERSION')}
const material=value=>{
  if(value===undefined||typeof value==='string')return value
  if(value instanceof Uint8Array)return Array.from(value)
  if(Array.isArray(value)&&value.every(item=>typeof item==='string'))return value.join('\n')
  throw fail('ERR_INVALID_ARG_TYPE','Expected TLS certificate/key bytes')
}
function contextSettings(options={}){
  for(const name of ['pfx','passphrase','ciphers','sigalgs','ecdhCurve','secureProtocol','secureOptions','crl','dhparam'])
    if(options[name]!==undefined)throw fail('ERR_UNSUPPORTED_OPERATION','TLS option is not implemented: '+name)
  return {ca:material(options.ca),cert:material(options.cert),key:material(options.key),minVersion:version(options.minVersion??'TLSv1.2'),maxVersion:version(options.maxVersion??'TLSv1.3')}
}
export class SecureContext {
  constructor(options={}){const settings=contextSettings(options);call('validate',settings);contexts.set(this,settings)}
}
export const createSecureContext=options=>new SecureContext(options)

export class TLSSocket extends Duplex {
  constructor(socket,options={}){
    super({allowHalfOpen:options.allowHalfOpen??false,autoDestroy:true,emitClose:false})
    if(options.ALPNProtocols!==undefined||options.SNICallback!==undefined||options.checkServerIdentity!==undefined||options.session!==undefined)
      throw fail('ERR_UNSUPPORTED_OPERATION','TLS ALPN, SNI callbacks, sessions and custom identity callbacks are not implemented')
    this._socket=socket??new NetSocket();this._server=!!options.isServer;this.encrypted=true;this.authorized=false;this.authorizationError=null
    this.connecting=!!this._socket.connecting;this.secureConnecting=true;this._plainWanted=true;this._input=[];this._inputOffset=0
    const settings=options.secureContext?contexts.get(options.secureContext):contextSettings(options)
    if(!settings)throw fail('ERR_INVALID_ARG_TYPE','Expected a SecureContext')
    this.servername=options.servername??(this._server?'':options.host??'localhost')
    const verification=this._server?(options.requestCert?(options.rejectUnauthorized===false?'optional':'required'):'none'):(options.rejectUnauthorized===false?'optional':'required')
    this._id=call('open',{...settings,server:this._server,servername:this.servername,minVersion:version(options.minVersion??(settings.minVersion===12?'TLSv1.2':'TLSv1.3')),maxVersion:version(options.maxVersion??(settings.maxVersion===12?'TLSv1.2':'TLSv1.3')),verification})
    this._socket.on('data',bytes=>{this._socket.pause();this._input.push(bytes);this._schedule()})
    this._socket.on('connect',()=>{this.connecting=false;this.emit('connect');this._schedule()})
    this._socket.on('end',()=>{
      if(this.destroyed)return
      if(!this._secure){this.destroy(fail('ECONNRESET','Disconnected before the TLS handshake completed'));return}
      this._transportEnded=true;this._schedule()
    })
    this._socket.on('error',error=>this.destroy(error))
    this._socket.on('timeout',()=>this.emit('timeout'))
    this._socket.on('close',()=>{if(!this.destroyed&&!this._transportEnded)this.destroy()})
    const timeout=options.handshakeTimeout??120000
    if(!Number.isFinite(timeout)||timeout<0){this.destroy();throw fail('ERR_OUT_OF_RANGE','Invalid TLS handshake timeout')}
    if(timeout){this._handshakeTimer=setTimeout(()=>this.destroy(fail('ERR_TLS_HANDSHAKE_TIMEOUT')),timeout);this._handshakeTimer.unref?.()}
    if(this._server||!this._socket.pending)this._schedule()
  }
  _schedule(){if(this.destroyed||this._scheduled)return;this._scheduled=setImmediate(()=>{this._scheduled=null;this._pump()})}
  _read(){this._plainWanted=true;this._schedule()}
  _write(bytes,_encoding,callback){this._applicationWrite={bytes,offset:0,callback};this._schedule()}
  _final(callback){this._finish=callback;this._schedule()}
  _flush(){
    if(this._writingCiphertext)return true
    const encrypted=call('drain',this._id)
    if(!encrypted.length)return false
    this._writingCiphertext=true
    this._socket.write(Buffer.from(encrypted),error=>{
      this._writingCiphertext=false
      if(error)this.destroy(error);else this._schedule()
    })
    return true
  }
  _pump(){
    if(this.destroyed||this._pumping)return
    this._pumping=true
    try{
      if(this._id===undefined)return
      while(this._input.length){
        const chunk=this._input[0],rest=chunk.subarray(this._inputOffset,this._inputOffset+65536)
        const accepted=call('feed',this._id,Array.from(rest));this._inputOffset+=accepted
        if(this._inputOffset===chunk.length){this._input.shift();this._inputOffset=0}
        if(accepted<rest.length)break
      }
      if(this._transportEnded&&!this._input.length&&!this._fedEOF){call('eof',this._id);this._fedEOF=true}
      let progress=false
      if(!this._secure){
        const code=call('step',this._id)
        if(code===0){
          this._secure=true;this.secureConnecting=false;clearTimeout(this._handshakeTimer)
          const info=call('info',this._id);this._protocol=info.protocol;this.authorized=info.verifyFlags===0
          if(!this.authorized)this.authorizationError='TLS certificate verification flags: '+info.verifyFlags
          this.emit('secure');if(!this._server)this.emit('secureConnect')
        }else progress=code===1||code===-0x7000
      }
      if(this.destroyed)return
      if(this._secure){
        const pending=this._applicationWrite
        if(pending){
          const part=pending.bytes.subarray(pending.offset,pending.offset+16384)
          const written=call('write',this._id,Array.from(part))
          if(written>=0){
            pending.offset+=written;progress=true
            if(pending.offset===pending.bytes.length){this._applicationWrite=null;pending.callback()}
          }
        }
        if(this._plainWanted&&!this._receivedEnd){
          const read=call('read',this._id)
          if(read.code>0){this._plainWanted=this.push(Buffer.from(read.bytes));progress=true}
          else if(read.code===0||read.code===-0x7880){this._receivedEnd=true;this.push(null)}
        }
        if(this._finish&&!this._closing){
          const code=call('close',this._id)
          if(code===0)this._closing=true
        }
      }
      // Reads and writes are independent. Waiting for a blocked write before
      // resuming reads can deadlock two peers sending more than a queue holds.
      if(!this._input.length)this._socket.resume()
      if(this._flush())return
      // Finishing the writable side must not leave the transport paused. The
      // peer's remaining records and close notification still need to be read.
      if(this._closing&&this._finish){const callback=this._finish;this._finish=null;this._socket.end(callback)}
      if(progress||this._input.length&&(!this._secure||this._plainWanted))this._schedule()
    }catch(error){this.destroy(error)}finally{this._pumping=false}
  }
  _destroy(error,callback){
    clearTimeout(this._handshakeTimer);if(this._scheduled)clearImmediate(this._scheduled)
    this._scheduled=null;this.connecting=false;this.secureConnecting=false
    if(this._id!==undefined){try{call('destroy',this._id)}catch{}this._id=undefined}
    this._input=[]
    const pending=this._applicationWrite;this._applicationWrite=null
    if(pending)pending.callback(error??fail('ERR_STREAM_DESTROYED'))
    const finish=this._finish;this._finish=null;if(finish)finish(error??fail('ERR_STREAM_DESTROYED'))
    this._socket.destroy(error);callback(error)
    process.nextTick(()=>this.emit('close',!!error))
  }
  getProtocol(){return this._protocol??null}
  address(){return this._socket.address()}
  setTimeout(...args){this._socket.setTimeout(...args);return this}
  setNoDelay(...args){this._socket.setNoDelay(...args);return this}
  setKeepAlive(...args){this._socket.setKeepAlive(...args);return this}
  ref(){this._socket.ref();return this}
  unref(){this._socket.unref();return this}
  get localAddress(){return this._socket.localAddress}
  get localPort(){return this._socket.localPort}
  get remoteAddress(){return this._socket.remoteAddress}
  get remotePort(){return this._socket.remotePort}
  get remoteFamily(){return this._socket.remoteFamily}
}

export function connect(...args){
  const callback=typeof args.at(-1)==='function'?args.pop():undefined
  let options
  if(args[0]&&typeof args[0]==='object')options={...args[0]}
  else {const [port,hostOrOptions,extra]=args;options={...(typeof hostOrOptions==='object'?hostOrOptions:extra),port,...(typeof hostOrOptions==='string'?{host:hostOrOptions}:{})}}
  const raw=options.socket??new NetSocket()
  const socket=new TLSSocket(raw,options)
  if(callback)socket.once('secureConnect',callback)
  if(!options.socket){socket.connecting=true;raw.connect({port:options.port,host:options.host??'localhost'})}
  return socket
}

export class Server extends NetServer {
  constructor(options={},listener){
    if(typeof options==='function'){listener=options;options={}}
    super({allowHalfOpen:true})
    this._tlsOptions={...options,secureContext:options.secureContext??createSecureContext(options)}
    if(listener)this.on('secureConnection',listener)
    this.on('connection',raw=>{
      let socket
      try{
        socket=new TLSSocket(raw,{...this._tlsOptions,isServer:true})
        socket.on('error',error=>{if(!socket._secure)this.emit('tlsClientError',error,socket)})
        socket.once('secure',()=>this.emit('secureConnection',socket))
      }catch(error){raw.destroy();this.emit('tlsClientError',error,raw)}
    })
  }
  setSecureContext(options){this._tlsOptions={...this._tlsOptions,secureContext:createSecureContext(options)};return this}
}
export const createServer=(...args)=>new Server(...args)
export const DEFAULT_MIN_VERSION='TLSv1.2',DEFAULT_MAX_VERSION='TLSv1.3'
export default {TLSSocket,SecureContext,Server,connect,createServer,createSecureContext,DEFAULT_MIN_VERSION,DEFAULT_MAX_VERSION}
