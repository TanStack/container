import {Duplex,Readable,Writable} from 'node:stream'
import {EventEmitter} from 'node:events'
import {Buffer} from 'node:buffer'
import {Server as NetServer,connect as netConnect} from 'node:net'
import {URL} from 'node:url'
import process from 'node:process'
import {AsyncLocalStorage} from 'node:async_hooks'

const fail=(code,message=code)=>Object.assign(new Error(message),{code})
const call=(method,...args)=>{
  const backend=globalThis.__webContainerHost.http2
  if(!backend)throw fail('ERR_UNSUPPORTED_OPERATION','HTTP/2 requires the worker-owned kernel')
  return backend.call(method,...args)
}
const unsupported=name=>{throw fail('ERR_UNSUPPORTED_OPERATION','HTTP/2 '+name+' is not implemented')}
export const constants=Object.freeze({NGHTTP2_NO_ERROR:0,NGHTTP2_PROTOCOL_ERROR:1,NGHTTP2_INTERNAL_ERROR:2,NGHTTP2_FLOW_CONTROL_ERROR:3,NGHTTP2_REFUSED_STREAM:7,NGHTTP2_CANCEL:8,NGHTTP2_SESSION_CLIENT:1,NGHTTP2_SESSION_SERVER:0,NGHTTP2_FLAG_END_STREAM:1,HTTP2_HEADER_METHOD:':method',HTTP2_HEADER_PATH:':path',HTTP2_HEADER_SCHEME:':scheme',HTTP2_HEADER_AUTHORITY:':authority',HTTP2_HEADER_STATUS:':status',HTTP2_METHOD_GET:'GET',HTTP2_METHOD_POST:'POST',HTTP_STATUS_OK:200})
function pairs(headers){
  if(!headers||typeof headers!=='object'||Array.isArray(headers))throw fail('ERR_INVALID_ARG_TYPE','Expected HTTP/2 headers')
  const result=[]
  for(const key of Object.keys(headers)){
    if(headers[key]===undefined)continue
    const name=key.toLowerCase()
    if(['connection','upgrade','keep-alive','proxy-connection','transfer-encoding'].includes(name))throw fail('ERR_HTTP2_INVALID_CONNECTION_HEADERS')
    for(const value of Array.isArray(headers[key])?headers[key]:[headers[key]])result.push([name,String(value)])
  }
  return result.sort((a,b)=>Number(b[0].startsWith(':'))-Number(a[0].startsWith(':')))
}
function decoded(entries){
  const headers=Object.create(null),raw=[]
  for(const [name,value] of entries){
    raw.push(name,value)
    if(name==='set-cookie')(headers[name]??=[]).push(value)
    else if(name===':status')headers[name]=Number(value)
    else headers[name]=headers[name]===undefined?value:headers[name]+(name==='cookie'?'; ':', ')+value
  }
  return {headers,raw}
}

export class Http2Stream extends Duplex {
  constructor(session,id,server){
    super({allowHalfOpen:true,autoDestroy:false})
    this.session=session;this.id=id;this.pending=false;this.sentHeaders=undefined;this.rstCode=0;this.aborted=false
    this._server=server;this._credit=0;this._wireClosed=false;this._nativeEnded=false
    this._run=AsyncLocalStorage.snapshot()
    this.on('end',()=>this._maybeClose());this.on('finish',()=>this._maybeClose())
  }
  emit(event,...args){
    // readable-stream emits data for flowing reads and explicit read(). Merely
    // pushing into its buffer must not reopen the HTTP/2 receive window.
    if(event==='data'&&this._credit&&this.session&&!this.session.destroyed){
      const bytes=typeof args[0]==='string'?Buffer.byteLength(args[0],this.readableEncoding??'utf8'):args[0].length
      const used=Math.min(bytes,this._credit)
      if(used){call('consume',this.session._id,this.id,used);this._credit-=used;this.session._schedule()}
    }
    return super.emit(event,...args)
  }
  _read(){}
  _write(bytes,_encoding,callback){
    if(this._server&&!this.headersSent)this.respond()
    if(this._nativeEnded){callback(fail('ERR_STREAM_WRITE_AFTER_END'));return}
    this._pendingWrite={bytes,offset:0,callback};this.session._schedule()
  }
  _final(callback){
    try{
      if(this._server&&!this.headersSent)this.respond()
      if(!this._nativeEnded){call('write',this.session._id,this.id,[],true);this._nativeEnded=true}
      this.session._schedule();callback()
    }catch(error){callback(error)}
  }
  _produce(){
    const pending=this._pendingWrite;if(!pending)return
    const bytes=pending.bytes.subarray(pending.offset,pending.offset+16384)
    pending.offset+=call('write',this.session._id,this.id,Array.from(bytes),false)
    if(pending.offset===pending.bytes.length){this._pendingWrite=null;this._run(pending.callback)}
  }
  _maybeClose(){if(this._wireClosed&&this.readableEnded&&this.writableFinished&&!this.destroyed)this.destroy()}
  sendTrailers(headers){
    if(this.destroyed||this.session.destroyed)throw fail('ERR_HTTP2_INVALID_STREAM')
    if(this.sentTrailers)throw fail('ERR_HTTP2_TRAILERS_ALREADY_SENT')
    if(!this._trailersReady)throw fail('ERR_HTTP2_TRAILERS_NOT_READY')
    const entries=pairs(headers)
    if(entries.some(([name])=>name.startsWith(':')))throw fail('ERR_HTTP2_INVALID_PSEUDOHEADER')
    call('trailers',this.session._id,this.id,entries)
    this.sentTrailers={...headers};this.session._schedule()
  }
  _destroy(error,callback){
    const session=this.session,pending=this._pendingWrite;this._pendingWrite=null
    try{
      if(!session.destroyed){
        if(this._credit){call('consume',session._id,this.id,this._credit);this._credit=0}
        if(!this._wireClosed){this.rstCode=this._resetCode??8;call('reset',session._id,this.id,this.rstCode)}
        session._schedule()
      }
    }catch(cause){error??=cause}
    clearTimeout(this._timer);session._streams.delete(this.id)
    if(pending)this._run(pending.callback,error??fail('ERR_STREAM_DESTROYED'))
    this._run(callback,error)
  }
  close(code=0,callback){if(typeof code==='function'){callback=code;code=0}if(callback)this.once('close',callback);this._resetCode=code;this.rstCode=code;this.destroy();return this}
  setTimeout(ms,callback){if(!Number.isFinite(ms)||ms<0)throw fail('ERR_OUT_OF_RANGE');clearTimeout(this._timer);if(callback)this.once('timeout',callback);if(ms)this._timer=setTimeout(()=>this.emit('timeout'),ms);return this}
}
export class ClientHttp2Stream extends Http2Stream {}
export class ServerHttp2Stream extends Http2Stream {
  respond(headers={},options={}){
    if(this.headersSent)throw fail('ERR_HTTP2_HEADERS_SENT')
    const values={':status':200,...headers}
    this._waitForTrailers=!!options.waitForTrailers
    call('headers',this.session._id,this.id,pairs(values),!!options.endStream&&!this._waitForTrailers,this._waitForTrailers)
    this.headersSent=true;this.sentHeaders=values;this._nativeEnded=!!options.endStream&&!this._waitForTrailers
    if(options.endStream)this.end()
    this.session._schedule()
  }
}

export class Http2Session extends EventEmitter {
  constructor(socket,server,authority){
    super();this.socket=socket;this.type=server?0:1;this.connecting=!!socket.connecting;this.closed=false;this.destroyed=false
    this._server=server;this._authority=authority;this._id=call('open',server);this._streams=new Map();this._headers=new Map()
    socket.on('data',bytes=>{
      if(this.destroyed)return
      try{for(let offset=0;offset<bytes.length;offset+=16384){call('feed',this._id,Array.from(bytes.subarray(offset,offset+16384)));this._drainEvents()}this._schedule()}
      catch(error){this.destroy(error)}
    })
    socket.on('connect',()=>{this.connecting=false;this.emit('connect',this,socket);this._schedule()})
    socket.on('error',error=>this.destroy(error))
    socket.on('end',()=>{this._transportEnded=true;this.closed=true;this._schedule()})
    socket.on('close',()=>{if(!this._transportEnded&&!this.destroyed)this.destroy()})
    if(!this.connecting)process.nextTick(()=>{if(!this.destroyed){this.emit('connect',this,socket);this._schedule()}})
  }
  _schedule(){if(!this.destroyed&&!this._scheduled)this._scheduled=setImmediate(()=>{this._scheduled=null;this._pump()})}
  _pump(){
    if(this.destroyed)return
    try{
      for(const stream of this._streams.values())stream._produce()
      if(this._writing)return
      const bytes=call('send',this._id,16384);this._drainEvents()
      if(bytes.length){
        this._writing=true
        this.socket.write(Buffer.from(bytes),error=>{this._writing=false;if(error)this.destroy(error);else this._schedule()})
      }else if(this.closed&&!this._streams.size){
        if(this._transportEnded)this.destroy()
        else if(!this._ending){this._ending=true;this.socket.end()}
      }
    }catch(error){this.destroy(error)}
  }
  _drainEvents(){
    for(const event of call('events',this._id)){
      if(this.destroyed)return
      let stream=this._streams.get(event.stream)
      if(event.type===1){
        const text=Buffer.from(event.bytes).toString(),split=text.indexOf('\0')
        let entries=this._headers.get(event.stream);if(!entries)this._headers.set(event.stream,entries=[])
        entries.push([text.slice(0,split),text.slice(split+1)])
      }else if(event.type===2){
        if(stream&&!stream.destroyed){stream._credit+=event.bytes.length;stream._run(()=>stream.push(Buffer.from(event.bytes)))}
        else call('consume',this._id,event.stream,event.bytes.length)
      }else if(event.type===3||event.type===7){
        const entries=this._headers.get(event.stream)??(event.type===7?[]:undefined)
        if(entries){
          this._headers.delete(event.stream);const {headers,raw}=decoded(entries)
          if(this._server&&!stream){stream=new ServerHttp2Stream(this,event.stream,true);this._streams.set(event.stream,stream);this.emit('stream',stream,headers,event.flags,raw)}
          else if(stream)stream._run(()=>stream.emit(event.type===7&&!Object.hasOwn(headers,':status')?'trailers':headers[':status']<200?'headers':'response',headers,event.flags,raw))
        }
        if(event.flags&1&&stream&&!stream.destroyed)stream._run(()=>{stream.push(null);stream.read(0)})
      }else if(event.type===4&&stream){
        stream._wireClosed=true;stream.rstCode=event.flags>>>0
        if(event.flags){stream.aborted=true;stream._run(()=>{stream.emit('aborted');stream.destroy(event.flags===8?undefined:fail('ERR_HTTP2_STREAM_ERROR','HTTP/2 stream error: '+event.flags))})}
        else stream._maybeClose()
      }else if(event.type===5){this.closed=true;this.emit('goaway',event.flags>>>0,event.stream,Buffer.alloc(0));this._schedule()}
      else if(event.type===6&&stream&&!stream.destroyed){stream._trailersReady=true;stream._run(()=>stream.emit('wantTrailers'))}
    }
  }
  close(callback){
    if(callback)this.once('close',callback)
    if(!this.closed&&!this.destroyed){this.closed=true;call('goaway',this._id,0);this._schedule()}
    return this
  }
  destroy(error){
    if(this.destroyed)return this
    this.destroyed=true;this.closed=true;clearImmediate(this._scheduled)
    for(const stream of [...this._streams.values()])stream.destroy(error)
    this._streams.clear();this._headers.clear()
    try{call('destroy',this._id)}catch(cause){error??=cause}
    this.socket.destroy()
    process.nextTick(()=>{if(error)this.emit('error',error);this.emit('close')})
    return this
  }
  ref(){this.socket.ref();return this}
  unref(){this.socket.unref();return this}
  setTimeout(ms,callback){this.socket.setTimeout(ms,callback);return this}
}
export class ClientHttp2Session extends Http2Session {
  request(headers={},options={}){
    if(this.closed||this.destroyed)throw fail('ERR_HTTP2_INVALID_SESSION')
    const values={':method':'GET',':path':'/',':scheme':'http',':authority':this._authority,...headers}
    const end=options.endStream??['GET','HEAD','DELETE'].includes(values[':method'])
    const wait=!!options.waitForTrailers
    const id=call('headers',this._id,0,pairs(values),!!end&&!wait,wait)
    const stream=new ClientHttp2Stream(this,id,false);this._streams.set(id,stream)
    stream.sentHeaders=values;stream._nativeEnded=!!end&&!wait;stream._waitForTrailers=wait
    if(end)stream.end()
    this._schedule();return stream
  }
}
export class ServerHttp2Session extends Http2Session {}
export class Http2ServerRequest extends Readable {
  constructor(stream,headers,options={},rawHeaders=[]){
    super({autoDestroy:false})
    this.stream=stream;this.headers=headers;this.rawHeaders=rawHeaders
    this.trailers=Object.create(null);this.rawTrailers=[];this.complete=false;this.aborted=false
    this.httpVersion='2.0';this.httpVersionMajor=2;this.httpVersionMinor=0
    stream.on('data',chunk=>{if(!this.push(chunk))stream.pause()})
    stream.on('end',()=>{this.complete=true;this.push(null)})
    stream.on('trailers',(headers,_flags,raw)=>{this.trailers=headers;this.rawTrailers=raw})
    stream.on('aborted',()=>{this.aborted=true;this.emit('aborted')})
    stream.on('error',error=>this.destroy(error))
    stream.on('close',()=>{if(!this.destroyed)this.destroy()})
  }
  get method(){return this.headers[':method']}
  set method(value){this.headers[':method']=value}
  get url(){return this.headers[':path']}
  set url(value){this.headers[':path']=value}
  get authority(){return this.headers[':authority']}
  get scheme(){return this.headers[':scheme']}
  get socket(){return this.stream.session.socket}
  get connection(){return this.socket}
  _read(){this.stream.resume()}
  _destroy(error,callback){if(error)this.stream.destroy(error);callback(error)}
  setTimeout(ms,callback){this.stream.setTimeout(ms,callback);return this}
}
export class Http2ServerResponse extends Writable {
  constructor(stream,options={}){
    super({autoDestroy:false})
    this.stream=stream;this._headers=Object.create(null);this._statusCode=200;this.sendDate=true
    this._trailers=Object.create(null)
    stream.on('wantTrailers',()=>{if(!stream.destroyed)stream.sendTrailers(this._trailers)})
    stream.on('error',error=>this.destroy(error))
    stream.on('close',()=>{if(!this.destroyed)this.destroy()})
  }
  get socket(){return this.stream.session.socket}
  get connection(){return this.socket}
  get headersSent(){return !!this.stream.headersSent}
  get finished(){return this.writableEnded}
  get statusCode(){return this._statusCode}
  set statusCode(value){if(!Number.isInteger(value)||value<100||value>599)throw fail('ERR_HTTP2_STATUS_INVALID');if(value<200)throw fail('ERR_HTTP2_INFO_STATUS_NOT_ALLOWED');this._statusCode=value}
  get statusMessage(){return ''}
  set statusMessage(value){}
  _mutable(){if(this.headersSent)throw fail('ERR_HTTP2_HEADERS_SENT')}
  setHeader(name,value){this._mutable();name=String(name).toLowerCase();if(name.startsWith(':'))throw fail('ERR_HTTP2_PSEUDOHEADER_NOT_ALLOWED');pairs({[name]:value});this._headers[name]=value;return this}
  getHeader(name){return this._headers[String(name).toLowerCase()]}
  getHeaderNames(){return Object.keys(this._headers)}
  getHeaders(){return Object.assign(Object.create(null),this._headers)}
  hasHeader(name){return Object.hasOwn(this._headers,String(name).toLowerCase())}
  removeHeader(name){this._mutable();delete this._headers[String(name).toLowerCase()]}
  appendHeader(name,value){const previous=this.getHeader(name);return this.setHeader(name,previous===undefined?value:[].concat(previous,value))}
  writeHead(statusCode,statusMessage,headers){
    this._mutable();this.statusCode=statusCode
    if(typeof statusMessage==='object')headers=statusMessage
    if(Array.isArray(headers)){for(let i=0;i<headers.length;i+=2)this.appendHeader(headers[i],headers[i+1])}
    else if(headers)for(const name of Object.keys(headers))this.setHeader(name,headers[name])
    this.flushHeaders();return this
  }
  flushHeaders(){if(!this.headersSent){const headers={...this._headers,':status':this.statusCode};if(this.sendDate&&!Object.hasOwn(headers,'date'))headers.date=new Date().toUTCString();this.stream.respond(headers,{waitForTrailers:true})}}
  _write(chunk,encoding,callback){try{this.flushHeaders();if(this._head||this.statusCode===204||this.statusCode===304)callback();else this.stream.write(chunk,encoding,callback)}catch(error){callback(error)}}
  _final(callback){try{this.flushHeaders();this.stream.end(callback)}catch(error){callback(error)}}
  _destroy(error,callback){if(error)this.stream.destroy(error);callback(error)}
  setTimeout(ms,callback){this.stream.setTimeout(ms,callback);return this}
  addTrailers(headers){const entries=pairs(headers);if(entries.some(([name])=>name.startsWith(':')))throw fail('ERR_HTTP2_INVALID_PSEUDOHEADER');Object.assign(this._trailers,headers)}
  createPushResponse(){unsupported('server push')}
  writeContinue(){unsupported('informational headers')}
  writeEarlyHints(){unsupported('informational headers')}
}
export class Http2Server extends NetServer {
  constructor(options={},listener){
    if(typeof options==='function'){listener=options;options={}}
    super(options)
    if(listener)this.on('request',listener)
    this.on('connection',socket=>{
      const session=new ServerHttp2Session(socket,true)
      session.on('stream',(stream,headers,flags,raw)=>{
        this.emit('stream',stream,headers,flags,raw)
        if(this.listenerCount('request')){
          const request=new Http2ServerRequest(stream,headers,options,raw),response=new Http2ServerResponse(stream,options)
          response._head=headers[':method']==='HEAD'
          this.emit('request',request,response)
        }
      })
      session.on('error',error=>this.emit('sessionError',error,session))
      this.emit('session',session)
    })
  }
}
export const createServer=(...args)=>new Http2Server(...args)
export const createSecureServer=()=>unsupported('secure-server ALPN negotiation')
export function connect(authority,options={},listener){
  if(typeof options==='function'){listener=options;options={}}
  const url=authority instanceof URL?authority:new URL(authority)
  if(url.protocol!=='http:')unsupported('secure-client ALPN negotiation')
  const socket=options.createConnection?options.createConnection(url,options):netConnect({port:Number(url.port||80),host:url.hostname})
  const session=new ClientHttp2Session(socket,false,url.host)
  if(listener)session.once('connect',listener)
  return session
}
export default {connect,createServer,createSecureServer,constants,Http2Session,ClientHttp2Session,ServerHttp2Session,Http2Stream,ClientHttp2Stream,ServerHttp2Stream,Http2Server,Http2ServerRequest,Http2ServerResponse}
