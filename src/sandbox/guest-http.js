import {Readable, Writable} from 'node:stream'
import {Server as NetServer, createConnection} from 'node:net'
import {EventEmitter} from 'node:events'
import {Buffer} from 'node:buffer'
import process from 'node:process'

const error=(code,message=code)=>Object.assign(new Error(message),{code})
const token=/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
function duration(value){if(!Number.isInteger(value)||value<0)throw error('ERR_OUT_OF_RANGE');return value}
export const maxHeaderSize=16384
export const METHODS=['ACL','BIND','CHECKOUT','CONNECT','COPY','DELETE','GET','HEAD','LINK','LOCK','M-SEARCH','MERGE','MKACTIVITY','MKCALENDAR','MKCOL','MOVE','NOTIFY','OPTIONS','PATCH','POST','PROPFIND','PROPPATCH','PURGE','PUT','QUERY','REBIND','REPORT','SEARCH','SOURCE','SUBSCRIBE','TRACE','UNBIND','UNLINK','UNLOCK','UNSUBSCRIBE']
export const STATUS_CODES={100:'Continue',101:'Switching Protocols',102:'Processing',103:'Early Hints',200:'OK',201:'Created',202:'Accepted',203:'Non-Authoritative Information',204:'No Content',205:'Reset Content',206:'Partial Content',207:'Multi-Status',208:'Already Reported',226:'IM Used',300:'Multiple Choices',301:'Moved Permanently',302:'Found',303:'See Other',304:'Not Modified',305:'Use Proxy',307:'Temporary Redirect',308:'Permanent Redirect',400:'Bad Request',401:'Unauthorized',402:'Payment Required',403:'Forbidden',404:'Not Found',405:'Method Not Allowed',406:'Not Acceptable',407:'Proxy Authentication Required',408:'Request Timeout',409:'Conflict',410:'Gone',411:'Length Required',412:'Precondition Failed',413:'Payload Too Large',414:'URI Too Long',415:'Unsupported Media Type',416:'Range Not Satisfiable',417:'Expectation Failed',418:"I'm a Teapot",421:'Misdirected Request',422:'Unprocessable Entity',423:'Locked',424:'Failed Dependency',425:'Too Early',426:'Upgrade Required',428:'Precondition Required',429:'Too Many Requests',431:'Request Header Fields Too Large',451:'Unavailable For Legal Reasons',500:'Internal Server Error',501:'Not Implemented',502:'Bad Gateway',503:'Service Unavailable',504:'Gateway Timeout',505:'HTTP Version Not Supported',506:'Variant Also Negotiates',507:'Insufficient Storage',508:'Loop Detected',509:'Bandwidth Limit Exceeded',510:'Not Extended',511:'Network Authentication Required'}
export function validateHeaderName(name){if(typeof name!=='string'||!token.test(name))throw error('ERR_INVALID_HTTP_TOKEN','Invalid HTTP header name')}
export function validateHeaderValue(name,value){if(value===undefined)throw error('ERR_HTTP_INVALID_HEADER_VALUE');if(/[^\t\x20-\x7e\x80-\xff]/.test(String(value)))throw error('ERR_INVALID_CHAR','Invalid HTTP header value')}
function headers(lines){
  const raw=[],values=Object.create(null),distinct=Object.create(null)
  for(const line of lines){
    const colon=line.indexOf(':');if(colon<1||!token.test(line.slice(0,colon)))throw error('HPE_INVALID_HEADER_TOKEN')
    const name=line.slice(0,colon),key=name.toLowerCase(),value=line.slice(colon+1).replace(/^[\t ]+|[\t ]+$/g,'')
    if(/[^\t\x20-\x7e\x80-\xff]/.test(value))throw error('HPE_INVALID_HEADER_TOKEN')
    raw.push(name,value);(distinct[key]??=[]).push(value)
    if(key==='content-length'&&distinct[key].length>1)throw error('HPE_UNEXPECTED_CONTENT_LENGTH')
    if(key==='set-cookie')values[key]=distinct[key]
    else values[key]=distinct[key].join(key==='cookie'?'; ':', ')
  }
  return {raw,values,distinct}
}

export class IncomingMessage extends Readable {
  constructor(socket){super({autoDestroy:true});this.socket=this.connection=socket;this.complete=false;this.aborted=false;this.headers={};this.rawHeaders=[];this.trailers={};this.rawTrailers=[];this.httpVersion='1.1';this.httpVersionMajor=1;this.httpVersionMinor=1}
  _read(){if(this._parser?.message===this)this._parser.resume()}
  _destroy(cause,callback){if(!this.complete){this.aborted=true;this.emit('aborted');this.socket.destroy(cause)}callback(cause)}
  setTimeout(ms,callback){this.socket.setTimeout(ms,callback);return this}
}

// One incremental parser per socket. Body bytes are handed to a Readable, not
// accumulated into a whole request. Backpressure stops the socket itself.
class Parser {
  constructor(socket,{request,limit=maxHeaderSize,onMessage,onComplete,onUpgrade,onError,head=false}){
    Object.assign(this,{socket,request,limit,onMessage,onComplete,onUpgrade,onError,head})
    this.buffer=Buffer.alloc(0);this.state='headers';this.paused=false;this.running=false;this.detached=false
    this.data=chunk=>{this.buffer=this.buffer.length?Buffer.concat([this.buffer,chunk]):chunk;this.pump()}
    this.end=()=>{if(this.state==='eof'){this.finish()}else if(this.state!=='headers'||this.buffer.length)this.fail(error('HPE_INVALID_EOF_STATE'))}
    socket.on('data',this.data);socket.on('end',this.end)
  }
  detach(){this.detached=true;this.socket.off('data',this.data);this.socket.off('end',this.end)}
  fail(cause){if(this.detached)return;this.detach();this.onError(cause)}
  dispatch(callback,...args){try{return callback(...args)}catch(cause){this.callbackFailed=true;throw cause}}
  pause(){this.paused=true;this.socket.pause()}
  resume(){if(this.detached||this.gated)return;this.paused=false;this.pump();if(!this.paused&&!this.detached)this.socket.resume()}
  take(n){const part=this.buffer.subarray(0,n);this.buffer=this.buffer.subarray(n);return part}
  finish(){const message=this.message;this.state='headers';this.message=null;message.complete=true;this.dispatch(()=>message.push(null));this.dispatch(this.onComplete,message)}
  line(){const i=this.buffer.indexOf('\r\n');if(i<0){if(this.buffer.length>this.limit)throw error('HPE_HEADER_OVERFLOW');return null}if(i>this.limit)throw error('HPE_HEADER_OVERFLOW');return this.take(i+2).subarray(0,i).toString('latin1')}
  pump(){
    if(this.running||this.detached)return;this.running=true;this.callbackFailed=false
    try{while(!this.paused&&!this.detached){
      if(this.state==='headers'){
        const i=this.buffer.indexOf('\r\n\r\n');if(i<0){if(this.buffer.length>this.limit)throw error('HPE_HEADER_OVERFLOW');break}if(i+4>this.limit)throw error('HPE_HEADER_OVERFLOW')
        const lines=this.take(i+4).subarray(0,i).toString('latin1').split('\r\n'),start=lines.shift(),parsed=headers(lines)
        const m=new IncomingMessage(this.socket);m._parser=this;m.headers=parsed.values;m.rawHeaders=parsed.raw;m.headersDistinct=parsed.distinct
        const match=this.request?/^([^ ]+) ([^\x00-\x20\x7f]+) HTTP\/(1)\.(0|1)$/.exec(start):/^HTTP\/(1)\.(0|1) ([0-9]{3})(?: ([^\r\n]*))?$/.exec(start)
        if(!match)throw error(this.request?'HPE_INVALID_METHOD':'HPE_INVALID_CONSTANT')
        if(this.request){if(!METHODS.includes(match[1]))throw error('HPE_INVALID_METHOD');m.method=match[1];m.url=match[2];m.httpVersionMinor=Number(match[4])}
        else {m.httpVersionMinor=Number(match[2]);m.statusCode=Number(match[3]);m.statusMessage=match[4]??''}
        m.httpVersion='1.'+m.httpVersionMinor
        const length=m.headers['content-length'],transfer=m.headers['transfer-encoding']
        if(length!==undefined&&transfer!==undefined)throw error('HPE_INVALID_TRANSFER_ENCODING')
        if(length!==undefined&&(!/^[0-9]+$/.test(length)||!Number.isSafeInteger(Number(length))))throw error('HPE_INVALID_CONTENT_LENGTH')
        if(transfer!==undefined&&transfer.toLowerCase()!=='chunked')throw error('HPE_INVALID_TRANSFER_ENCODING')
        this.message=m
        if(this.request&&(m.method==='CONNECT'||m.headers.upgrade&&/\bupgrade\b/i.test(m.headers.connection??''))||!this.request&&m.statusCode===101){const head=this.buffer;this.buffer=Buffer.alloc(0);this.detach();this.dispatch(this.onUpgrade,m,head);break}
        const noBody=!this.request&&(this.head||m.statusCode<200||m.statusCode===204||m.statusCode===304)
        this.remaining=Number(length??0)
        this.state=noBody?'empty':transfer?'chunk-size':length!==undefined?'fixed':this.request?'empty':'eof'
        this.dispatch(this.onMessage,m)
        if(this.state==='empty'||this.state==='fixed'&&this.remaining===0)this.finish()
      }else if(this.state==='chunk-size'){
        const line=this.line();if(line===null)break
        if(!/^[0-9a-fA-F]+(?:;[^\x00-\x1f\x7f]*)?$/.test(line))throw error('HPE_INVALID_CHUNK_SIZE')
        this.remaining=parseInt(line,16);if(!Number.isSafeInteger(this.remaining))throw error('HPE_INVALID_CHUNK_SIZE')
        this.state=this.remaining?'chunk':'trailers';this.trailerLines=[];this.trailerBytes=0
      }else if(this.state==='trailers'){
        const line=this.line();if(line===null)break
        this.trailerBytes+=line.length+2;if(this.trailerBytes>this.limit)throw error('HPE_HEADER_OVERFLOW')
        if(line)this.trailerLines.push(line)
        else {const t=headers(this.trailerLines);if(t.values['content-length']!==undefined||t.values['transfer-encoding']!==undefined)throw error('HPE_UNEXPECTED_CONTENT_LENGTH');this.message.trailers=t.values;this.message.rawTrailers=t.raw;this.message.trailersDistinct=t.distinct;this.finish()}
      }else if(this.state==='chunk-crlf'){
        if(this.buffer.length<2)break;if(this.take(2).toString()!=='\r\n')throw error('HPE_INVALID_CHUNK_SIZE');this.state='chunk-size'
      }else {
        if(!this.buffer.length)break
        const fixed=this.state!=='eof',bytes=this.take(fixed?Math.min(this.remaining,this.buffer.length):this.buffer.length)
        if(fixed)this.remaining-=bytes.length
        if(!this.dispatch(()=>this.message.push(bytes)))this.pause()
        if(fixed&&this.remaining===0){if(this.state==='chunk')this.state='chunk-crlf';else this.finish()}
      }
    }}catch(cause){if(this.callbackFailed)throw cause;this.fail(cause)}finally{this.running=false}
  }
}

export class OutgoingMessage extends Writable {
  constructor(){super({autoDestroy:false});this._headers=new Map();this.headersSent=false;this._trailers='';this._bytes=0;this.strictContentLength=false;this._removed=new Set()}
  get connection(){return this.socket}
  get finished(){return this.writableEnded}
  setHeader(name,value){if(this.headersSent)throw error('ERR_HTTP_HEADERS_SENT');validateHeaderName(name);for(const item of Array.isArray(value)?value:[value])validateHeaderValue(name,item);this._headers.set(name.toLowerCase(),{name,value});this._removed.delete(name.toLowerCase());return this}
  setHeaders(values){for(const [name,value] of values)this.setHeader(name,value);return this}
  appendHeader(name,value){const old=this.getHeader(name);return this.setHeader(name,old===undefined?value:[...Array.isArray(old)?old:[old],...Array.isArray(value)?value:[value]])}
  getHeader(name){return this._headers.get(String(name).toLowerCase())?.value}
  hasHeader(name){return this._headers.has(String(name).toLowerCase())}
  getHeaderNames(){return [...this._headers.keys()]}
  getRawHeaderNames(){return [...this._headers.values()].map(h=>h.name)}
  getHeaders(){return Object.assign(Object.create(null),Object.fromEntries([...this._headers].map(([name,h])=>[name,h.value])))}
  removeHeader(name){if(this.headersSent)throw error('ERR_HTTP_HEADERS_SENT');this._headers.delete(name.toLowerCase());this._removed.add(name.toLowerCase())}
  addTrailers(values){for(const [name,value] of Object.entries(values)){validateHeaderName(name);validateHeaderValue(name,value);if(['content-length','transfer-encoding'].includes(name.toLowerCase()))throw error('ERR_HTTP_TRAILER_INVALID');this._trailers+=name+': '+value+'\r\n'}}
  setTimeout(ms,callback){if(callback)this.once('timeout',callback);this.socket?.setTimeout(ms,()=>this.emit('timeout'));return this}
  _headerBlock(){let text='';for(const {name,value} of this._headers.values())for(const item of Array.isArray(value)?value:[value])text+=name+': '+item+'\r\n';return text+'\r\n'}
  _validateFraming(){const length=this.getHeader('content-length'),transfer=this.getHeader('transfer-encoding');if(length!==undefined&&(!/^[0-9]+$/.test(String(length))||!Number.isSafeInteger(Number(length))))throw error('ERR_HTTP_INVALID_HEADER_VALUE');if(transfer!==undefined&&(String(transfer).toLowerCase()!=='chunked'||length!==undefined))throw error('ERR_HTTP_INVALID_HEADER_VALUE')}
  flushHeaders(){this._sendHeaders();return this}
  _write(bytes,encoding,callback){
    try{this._sendHeaders();if(this._noBody){callback();return}this._bytes+=bytes.length;if(!bytes.length){callback();return}
      this.socket.write(this._chunked?Buffer.concat([Buffer.from(bytes.length.toString(16)+'\r\n'),bytes,Buffer.from('\r\n')]):bytes,callback)
    }catch(cause){callback(cause)}
  }
  _final(callback){
    if(!this.socket){this._pendingFinal=callback;return}
    try{this._sendHeaders();if(this.strictContentLength&&!this._noBody&&this.hasHeader('content-length')&&Number(this.getHeader('content-length'))!==this._bytes)throw error('ERR_HTTP_CONTENT_LENGTH_MISMATCH')
      if(this._chunked&&!this._noBody)this.socket.write('0\r\n'+this._trailers+'\r\n',callback);else this.socket.write(Buffer.alloc(0),callback)
    }catch(cause){callback(cause)}
  }
  _destroy(cause,callback){this.socket?.destroy(cause);callback(cause)}
}

export class ServerResponse extends OutgoingMessage {
  constructor(req){super();this.req=req;this.socket=req.socket;this.statusCode=200;this.statusMessage=undefined;this.sendDate=true;this.shouldKeepAlive=req.httpVersionMinor===1&&!/\bclose\b/i.test(req.headers.connection??'')}
  writeHead(code,message,values){if(this.headersSent)throw error('ERR_HTTP_HEADERS_SENT');if(typeof message!=='string'){values=message;message=undefined}if(!Number.isInteger(code)||code<100||code>999)throw error('ERR_HTTP_INVALID_STATUS_CODE');this.statusCode=code;this.statusMessage=message;if(values){if(Array.isArray(values)){for(let i=0;i<values.length;i+=2)this.appendHeader(values[i],values[i+1])}else for(const [key,value] of Object.entries(values))this.setHeader(key,value)}this._sendHeaders();return this}
  _sendHeaders(){
    if(this.headersSent)return
    this._validateFraming()
    this._noBody=this.req.method==='HEAD'||this.statusCode<200||this.statusCode===204||this.statusCode===304
    const reason=this.statusMessage??STATUS_CODES[this.statusCode]??'unknown';validateHeaderValue('statusMessage',reason)
    if(this.sendDate&&!this.hasHeader('date')&&!this._removed.has('date'))this.setHeader('Date',new Date().toUTCString())
    if(!this._noBody&&!this.hasHeader('content-length')&&!this.hasHeader('transfer-encoding')){
      if(this.req.httpVersionMinor===1)this.setHeader('Transfer-Encoding','chunked');else this.shouldKeepAlive=false
    }
    this._chunked=String(this.getHeader('transfer-encoding')).toLowerCase()==='chunked'
    if(/\bclose\b/i.test(String(this.getHeader('connection'))))this.shouldKeepAlive=false
    if(!this.hasHeader('connection'))this.setHeader('Connection',this.shouldKeepAlive?'keep-alive':'close')
    this.headersSent=true;this.socket.write('HTTP/1.1 '+this.statusCode+' '+reason+'\r\n'+this._headerBlock())
  }
  writeContinue(callback){this.socket.write('HTTP/1.1 100 Continue\r\n\r\n',callback)}
  writeProcessing(){this.socket.write('HTTP/1.1 102 Processing\r\n\r\n')}
}

export class Server extends NetServer {
  constructor(settings={},listener){
    if(typeof settings==='function'){listener=settings;settings={}}
    super({allowHalfOpen:true});this._initializeHTTP(settings,listener)
    this.on('connection',socket=>this._connection(socket))
  }
  _initializeHTTP(settings,listener){
    this.timeout=0;this.keepAliveTimeout=duration(settings.keepAliveTimeout??5000);this.requestTimeout=duration(settings.requestTimeout??300000);this.headersTimeout=duration(settings.headersTimeout??Math.min(60000,this.requestTimeout||60000));this._sockets=new Set();this._httpOptions=settings
    if(settings.maxHeaderSize!==undefined&&(!Number.isInteger(settings.maxHeaderSize)||settings.maxHeaderSize<=0))throw error('ERR_OUT_OF_RANGE')
    if(listener)this.on('request',listener)
  }
  _connection(socket){
    this._sockets.add(socket);let req,res,requestDone=false,responseDone=false,upgraded=false,headerTimer,requestTimer
    const clearDeadlines=()=>{clearTimeout(headerTimer);clearTimeout(requestTimer)}
    const armDeadlines=()=>{clearDeadlines();const expired=()=>parser.fail(error('ERR_HTTP_REQUEST_TIMEOUT'));if(this.headersTimeout>0){headerTimer=setTimeout(expired,this.headersTimeout);headerTimer.unref?.()}if(this.requestTimeout>0){requestTimer=setTimeout(expired,this.requestTimeout);requestTimer.unref?.()}}
    const advance=()=>{if(!requestDone||!responseDone)return;if(!res.shouldKeepAlive||!this.listening){socket.end();return}req=res=null;socket._httpBusy=false;socket.setTimeout(this.keepAliveTimeout);armDeadlines();parser.gated=false;parser.resume()}
    const parser=new Parser(socket,{request:true,limit:this._httpOptions.maxHeaderSize??maxHeaderSize,
      onMessage:message=>{
        clearTimeout(headerTimer);req=message;res=new ServerResponse(req);socket._httpBusy=true;requestDone=responseDone=false
        socket.setTimeout(this.timeout)
        const response=res;res.on('error',()=>socket.destroy());res.once('finish',()=>{responseDone=true;req.resume();advance();response.emit('close')})
        if(req.headers.expect?.toLowerCase()==='100-continue'){if(this.listenerCount('checkContinue'))this.emit('checkContinue',req,res);else {res.writeContinue();this.emit('request',req,res)}}
        else if(req.headers.expect){if(this.listenerCount('checkExpectation'))this.emit('checkExpectation',req,res);else {res.writeHead(417);res.end()}}
        else this.emit('request',req,res)
      },
      onComplete:()=>{clearDeadlines();requestDone=true;parser.gated=true;parser.pause();advance()},
      onUpgrade:(message,head)=>{clearDeadlines();upgraded=true;socket._httpUpgraded=true;const kind=message.method==='CONNECT'?'connect':'upgrade';if(this.listenerCount(kind))this.emit(kind,message,socket,head);else socket.destroy()},
      onError:cause=>{clearDeadlines();if(this.listenerCount('clientError'))this.emit('clientError',cause,socket);else {socket.end('HTTP/1.1 '+(cause.code==='ERR_HTTP_REQUEST_TIMEOUT'?'408 Request Timeout':cause.code==='HPE_HEADER_OVERFLOW'?'431 Request Header Fields Too Large':'400 Bad Request')+'\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')}}})
    armDeadlines()
    socket.on('timeout',()=>{if(!this.emit('timeout',socket))socket.destroy()})
    socket.on('error',cause=>{if(req&&!req.complete){req.on('error',()=>{});req.destroy(cause)}})
    socket.on('end',()=>{if(!upgraded&&(!res||responseDone))socket.end()})
    socket.once('close',()=>{clearDeadlines();parser.detach();this._sockets.delete(socket);if(req&&!req.complete){req.on('error',()=>{});req.destroy(error('ECONNRESET'))}if(res&&!responseDone)res.destroy()})
  }
  setTimeout(ms,callback){this.timeout=duration(ms);if(callback)this.on('timeout',callback);return this}
  close(callback){super.close(callback);this.closeIdleConnections();return this}
  closeIdleConnections(){for(const socket of this._sockets)if(!socket._httpBusy&&!socket._httpUpgraded)socket.end()}
  closeAllConnections(){for(const socket of this._sockets)if(!socket._httpUpgraded)socket.destroy()}
}

export class Agent extends EventEmitter {
  constructor(options={}){
    super();this.options={...options};this.keepAlive=Boolean(options.keepAlive);this.keepAliveMsecs=options.keepAliveMsecs??1000;this.maxSockets=options.maxSockets??Infinity;this.maxFreeSockets=options.maxFreeSockets??256;this.scheduling=options.scheduling??'lifo';this.defaultPort=80;this.protocol='http:'
    if(options.maxTotalSockets!==undefined&&options.maxTotalSockets!==Infinity)throw error('ERR_UNSUPPORTED_OPERATION','HTTP agent maxTotalSockets is not implemented')
    if(!(this.maxSockets>0)||!(this.maxFreeSockets>=0)||!['fifo','lifo'].includes(this.scheduling))throw error('ERR_INVALID_ARG_VALUE')
    this.sockets=Object.create(null);this.freeSockets=Object.create(null);this.requests=Object.create(null);this._sockets=new Set()
  }
  createConnection(options,callback){const {path,...socketOptions}=options;return createConnection(socketOptions,callback)}
  addRequest(req,options){
    const name=this.getName(options),free=this.freeSockets[name]
    if(free?.length){const socket=this.scheduling==='fifo'?free.shift():free.pop();if(!free.length)delete this.freeSockets[name];this._assign(req,socket,options,name,true);return}
    if((this.sockets[name]?.length??0)<this.maxSockets){this._assign(req,this.createConnection({...this.options,...options}),options,name,false);return}
    ;(this.requests[name]??=[]).push({req,options})
  }
  _assign(req,socket,options,name,reused){
    const active=this.sockets[name]??(this.sockets[name]=[]);if(!active.includes(socket))active.push(socket)
    if(!this._sockets.has(socket)){this._sockets.add(socket);socket.once('close',()=>this._remove(socket,name))}
    socket.setTimeout(0);req.reusedSocket=reused;req._agentOptions=options;req._agentName=name;req.onSocket(socket)
  }
  _remove(socket,name){
    this._sockets.delete(socket);for(const table of [this.sockets,this.freeSockets]){const list=table[name],i=list?.indexOf(socket)??-1;if(i>=0)list.splice(i,1);if(list&&!list.length)delete table[name]}
    this._dequeue(name)
  }
  _dequeue(name){
    const queued=this.requests[name];if(!queued?.length)return
    const item=queued.shift();if(!queued.length)delete this.requests[name]
    this._assign(item.req,this.createConnection({...this.options,...item.options}),item.options,name,false)
  }
  freeSocket(socket,options,name=this.getName(options)){
    const active=this.sockets[name],i=active?.indexOf(socket)??-1;if(i>=0)active.splice(i,1);if(active&&!active.length)delete this.sockets[name]
    const queued=this.requests[name]
    if(queued?.length){const item=queued.shift();if(!queued.length)delete this.requests[name];this._assign(item.req,socket,item.options,name,true);return true}
    const free=this.freeSockets[name]??(this.freeSockets[name]=[])
    if(!this.keepAlive||free.length>=this.maxFreeSockets){if(!free.length)delete this.freeSockets[name];socket.end();return false}
    socket.setKeepAlive(true,this.keepAliveMsecs);socket.unref?.();free.push(socket);return true
  }
  destroy(){for(const socket of [...this._sockets])socket.destroy()}
  getName(options){return (options.host??'localhost')+':'+(options.port??80)+':'}
}
export const globalAgent=new Agent()
function requestOptions(input,options){
  const URL=globalThis.URL
  if(typeof input==='string'||URL&&input instanceof URL){if(!URL)throw error('ERR_UNSUPPORTED_OPERATION','URL string requests require guest Web APIs');const url=new URL(input);input={protocol:url.protocol,hostname:url.hostname.replace(/^\[|\]$/g,''),port:url.port||undefined,path:url.pathname+url.search,auth:url.username||url.password?decodeURIComponent(url.username)+':'+decodeURIComponent(url.password):undefined}}
  return {...input,...options}
}
export class ClientRequest extends OutgoingMessage {
  constructor(input,options,callback){
    super();this.cork();if(typeof options==='function'){callback=options;options=undefined}const opts=requestOptions(input,options)
    if(opts.socketPath!==undefined)throw error('ERR_UNSUPPORTED_OPERATION','Unix socket paths are unavailable')
    const defaultAgent=opts._defaultAgent??globalAgent
    this.agent=opts.agent===false?new defaultAgent.constructor():opts.agent??defaultAgent
    this.protocol=opts.protocol??defaultAgent.protocol
    if(this.protocol!==this.agent.protocol)throw error('ERR_INVALID_PROTOCOL')
    const defaultPort=this.agent.defaultPort??80
    this.method=(opts.method??'GET').toUpperCase();if(!token.test(this.method))throw error('ERR_INVALID_HTTP_TOKEN')
    this.path=opts.path??'/';if(/[^\x21-\xff]/.test(this.path))throw error('ERR_UNESCAPED_CHARACTERS')
    this.host=opts.hostname??opts.host??'localhost';this.reusedSocket=false;this.aborted=false
    if(callback)this.once('response',callback)
    for(const [name,value] of Object.entries(opts.headers??{}))this.setHeader(name,value)
    if(!this.hasHeader('host'))this.setHeader('Host',this.host+(opts.port&&Number(opts.port)!==defaultPort?':'+opts.port:''))
    if(opts.auth&&!this.hasHeader('authorization'))this.setHeader('Authorization','Basic '+Buffer.from(opts.auth).toString('base64'))
    this.agent.addRequest(this,{...opts,host:this.host,port:opts.port??defaultPort})
    if(opts.timeout)this.setTimeout(opts.timeout)
    if(opts.signal){const abort=()=>this.destroy(Object.assign(error('ABORT_ERR','The operation was aborted'),{name:'AbortError',cause:opts.signal.reason}));if(opts.signal.aborted)process.nextTick(abort);else {opts.signal.addEventListener('abort',abort,{once:true});this.once('close',()=>opts.signal.removeEventListener('abort',abort))}}
  }
  onSocket(socket){
    this.socket=socket;let response,upgraded=false
    const socketError=cause=>{if(!this.destroyed)this.destroy(cause)}
    const socketClose=()=>{parser.detach();if(response&&!response.complete&&!upgraded){response.destroy(error('ECONNRESET'))}if(!response&&!this.destroyed)this.destroy(error('ECONNRESET','socket hang up'));else if(!this.destroyed)this.emit('close')}
    const parser=new Parser(socket,{request:false,head:this.method==='HEAD',onMessage:message=>{if(message.statusCode<200){if(message.statusCode===100)this.emit('continue');this.emit('information',{statusCode:message.statusCode,statusMessage:message.statusMessage,httpVersion:message.httpVersion,headers:message.headers,rawHeaders:message.rawHeaders});message.resume();return}response=message;message.req=this;this.res=message;if(!this.emit('response',message))message.resume()},
      onComplete:message=>{if(message.statusCode<200)return;parser.detach();const persistent=message.httpVersionMinor===1&&!/\bclose\b/i.test(message.headers.connection??'')&&this.agent.keepAlive;if(persistent){socket.off('error',socketError);socket.off('close',socketClose);this.agent.freeSocket(socket,this._agentOptions,this._agentName);this.emit('close')}else socket.end()},
      onUpgrade:(message,head)=>{response=message;upgraded=true;if(!this.emit('upgrade',message,socket,head))socket.destroy()},
      onError:cause=>{if(cause.code==='HPE_INVALID_EOF_STATE'&&response)socket.end(()=>response.destroy(error('ECONNRESET','aborted')));else this.destroy(cause)}})
    socket.on('error',socketError)
    socket.once('close',socketClose)
    process.nextTick(()=>{this.emit('socket',socket);this.uncork();if(this._pendingFinal){const callback=this._pendingFinal;this._pendingFinal=null;this._final(callback)}})
  }
  _sendHeaders(){if(this.headersSent)return;this._validateFraming();if(!this.hasHeader('connection'))this.setHeader('Connection',this.agent.keepAlive?'keep-alive':'close');if(!this.hasHeader('content-length')&&!this.hasHeader('transfer-encoding')&&!['GET','HEAD','DELETE','OPTIONS','TRACE','CONNECT'].includes(this.method))this.setHeader('Transfer-Encoding','chunked');this._chunked=String(this.getHeader('transfer-encoding')).toLowerCase()==='chunked';this.headersSent=true;this.socket.write(this.method+' '+this.path+' HTTP/1.1\r\n'+this._headerBlock())}
  abort(){if(!this.aborted){this.aborted=true;process.nextTick(()=>this.emit('abort'));this.destroy()}}
  setNoDelay(value){this.socket.setNoDelay(value);return this}
  setSocketKeepAlive(...args){this.socket.setKeepAlive(...args);return this}
}
export const createServer=(...args)=>new Server(...args)
export const request=(...args)=>new ClientRequest(...args)
export function get(...args){const req=request(...args);req.end();return req}
export default {Agent,globalAgent,ClientRequest,IncomingMessage,OutgoingMessage,Server,ServerResponse,createServer,request,get,METHODS,STATUS_CODES,maxHeaderSize,validateHeaderName,validateHeaderValue}
