import {Buffer} from 'buffer'
import {Readable,Writable,finished} from 'readable-stream'

function invalid(name,value){
  return Object.assign(new TypeError(`Invalid ${name}: ${String(value)}`),{code:'ERR_INVALID_ARG_TYPE'})
}
function position(value,name,infinity=false){
  if(value===undefined||(infinity&&value===Infinity))return value
  if(typeof value!=='number')throw invalid(name,value)
  if(!Number.isSafeInteger(value)||value<0)
    throw Object.assign(new RangeError(`${name} must be a non-negative safe integer`),{code:'ERR_OUT_OF_RANGE'})
  return value
}
function options(value){
  if(value===undefined||value===null)return {}
  if(typeof value==='string')return {encoding:value}
  if(typeof value!=='object'||Array.isArray(value))throw invalid('options',value)
  return {...value}
}
function path(value){
  if(value instanceof URL){
    if(value.protocol!=='file:')throw Object.assign(new TypeError('File URL required'),{code:'ERR_INVALID_URL_SCHEME'})
    if(value.hostname&&value.hostname!=='localhost')throw Object.assign(new TypeError('File URL host is not supported'),{code:'ERR_INVALID_FILE_URL_HOST'})
    if(/%2f/i.test(value.pathname))throw Object.assign(new TypeError('File URL contains an encoded slash'),{code:'ERR_INVALID_FILE_URL_PATH'})
    value=decodeURIComponent(value.pathname)
  }
  if(typeof value!=='string'&&!Buffer.isBuffer(value))throw invalid('path',value)
  if(value.includes(typeof value==='string'?'\0':0))throw invalid('path',value)
  return value
}

// The stream owns its lifecycle, not the file contents or descriptor cursor.
// All reads, writes and closes go through the caller's public callback API.
export function createNativeFilesystemStreamApi(callbacks,{keepAlive}={}){
  const state=Symbol('filesystem stream state')
  function handleOperations(handle){
    const operations={close(fd,done){handle.close().then(()=>done(null),done)}}
    for(const [name,count] of [['read','bytesRead'],['write','bytesWritten'],['writev','bytesWritten']]){
      if(typeof handle[name]!=='function')continue
      operations[name]=(fd,...args)=>{
        const done=args.pop()
        handle[name](...args).then(result=>done(null,result[count],result.buffer??result.buffers),done)
      }
    }
    if(typeof handle.sync==='function')operations.fsync=(fd,done)=>handle.sync().then(()=>done(null),done)
    return operations
  }
  function configuration(target,settings,writing){
    const handle=settings.fd&&typeof settings.fd==='object'?settings.fd:undefined
    if(handle&&settings.fs)throw Object.assign(new Error('File handles cannot use a custom fs provider'),{code:'ERR_METHOD_NOT_IMPLEMENTED'})
    const fs=handle?handleOperations(handle):settings.fs??callbacks,fd=handle?handle.fd:settings.fd
    if(fd!==undefined&&fd!==null&&(!Number.isInteger(fd)||fd<0))throw invalid('fd',fd)
    const methods=[...(fd==null?['open']:[]),...(writing?[]:['read']),...(settings.autoClose===false?[]:['close'])]
    for(const name of methods)if(typeof fs[name]!=='function')throw invalid(`options.fs.${name}`,fs[name])
    if(writing&&typeof fs.write!=='function'&&typeof fs.writev!=='function')throw invalid('options.fs.write',fs.write)
    if(settings.flush!==undefined&&typeof settings.flush!=='boolean')throw invalid('flush',settings.flush)
    if(writing&&settings.flush&&typeof fs.fsync!=='function')throw invalid('options.fs.fsync',fs.fsync)
    if(writing&&settings.encoding!==undefined&&!Buffer.isEncoding(settings.encoding))
      throw Object.assign(new TypeError('Invalid stream encoding'),{code:'ERR_UNKNOWN_ENCODING'})
    const start=position(settings.start,'start'),end=writing?undefined:position(settings.end,'end',true)??Infinity
    if(!writing&&start!==undefined&&start>end)
      throw Object.assign(new RangeError('start must be at or before end'),{code:'ERR_OUT_OF_RANGE'})
    return {fs,fd:fd??null,handle,start,end,path:fd==null?path(target):undefined,
      flags:settings.flags??(writing?'w':'r'),mode:settings.mode??0o666,flush:writing&&settings.flush===true}
  }
  function initialize(stream,config,writing){
    stream.fd=config.fd
    if(config.fd===null){stream.path=config.path;stream.flags=config.flags;stream.mode=config.mode}
    stream.start=config.start
    stream.pos=config.start
    if(!writing){
      stream.end=config.end
      stream.bytesRead=0
    }else stream.bytesWritten=0
    stream[state]={fs:config.fs,active:false,waiting:undefined,flush:config.flush}
    if(config.handle?.on){
      const destroy=()=>stream.destroy()
      config.handle.on('close',destroy)
      stream.once('close',()=>config.handle.removeListener?.('close',destroy))
    }
  }
  function construct(stream,done){
    if(stream.fd!==null){done();return}
    const stop=keepAlive?.()
    stream[state].fs.open(stream.path,stream.flags,stream.mode,(error,fd)=>{
      stop?.()
      if(error){done(error);return}
      stream.fd=fd;done();stream.emit('open',fd);stream.emit('ready')
    })
  }
  function release(stream,error,done){
    const entry=stream[state]
    if(entry.active){entry.waiting=ioError=>release(stream,error??ioError,done);return}
    const fd=stream.fd
    if(fd===null){done(error);return}
    stream.fd=null
    const stop=keepAlive?.()
    const close=flushError=>entry.fs.close(fd,closeError=>{stop?.();done(error??flushError??closeError)})
    if(entry.flush)entry.fs.fsync(fd,close)
    else close()
  }
  function complete(stream,error){
    const entry=stream[state];entry.active=false
    const stop=entry.stop;entry.stop=undefined;stop?.()
    const waiting=entry.waiting;entry.waiting=undefined
    waiting?.(error)
  }
  class ReadStream extends Readable{
    constructor(target,value){
      const settings=options(value),config=configuration(target,settings,false)
      super({...settings,autoDestroy:settings.autoClose!==false,highWaterMark:settings.highWaterMark??65536})
      initialize(this,config,false)
    }
    get pending(){return this.fd===null}
    // Node retains open() as a deprecated no-op, _construct owns the open.
    open(){}
    get autoClose(){return this._readableState.autoDestroy}
    set autoClose(value){this._readableState.autoDestroy=value}
    _construct(done){construct(this,done)}
    _read(size){
      const amount=Math.min(size,this.end-(this.pos??this.bytesRead)+1)
      if(amount<=0){this.push(null);return}
      const buffer=Buffer.alloc(amount),entry=this[state]
      entry.active=true;entry.stop=keepAlive?.()
      const receive=(error,count)=>{
        complete(this,error)
        if(this.destroyed)return
        if(error){if(this.autoClose)this.destroy(error);else this.emit('error',error);return}
        this.bytesRead+=count
        if(this.pos!==undefined)this.pos+=count
        this.push(count?buffer.subarray(0,count):null)
      }
      try{entry.fs.read(this.fd,buffer,0,amount,this.pos??null,receive)}catch(error){receive(error)}
    }
    _destroy(error,done){release(this,error,done)}
    close(callback){if(typeof callback==='function')finished(this,callback);this.destroy()}
  }
  class WriteStream extends Writable{
    constructor(target,value){
      const settings=options(value),config=configuration(target,settings,true)
      super({...settings,decodeStrings:true,autoDestroy:settings.autoClose!==false})
      initialize(this,config,true)
      if(settings.encoding)this.setDefaultEncoding(settings.encoding)
    }
    get pending(){return this.fd===null}
    open(){}
    get autoClose(){return this._writableState.autoDestroy}
    set autoClose(value){this._writableState.autoDestroy=value}
    _construct(done){construct(this,done)}
    _write(chunk,encoding,done){this.#write([chunk],done,false)}
    _writev(chunks,done){this.#write(chunks.map(item=>item.chunk),done,true)}
    #write(chunks,done,vector){
      const entry=this[state],size=chunks.reduce((sum,chunk)=>sum+chunk.byteLength,0)
      let offset=0,retries=0
      entry.active=true;entry.stop=keepAlive?.()
      const finish=error=>{complete(this,error);done(error)}
      const step=()=>{
        const current=this.pos===undefined?null:this.pos+offset
        const receive=(error,count)=>{
          if(error?.code==='EAGAIN'){error=undefined;count=0}
          if(error){finish(error);return}
          if(this.destroyed){finish(Object.assign(new Error('Stream was destroyed during write'),{code:'ERR_STREAM_DESTROYED'}));return}
          if(!Number.isInteger(count)||count<0||count>size-offset){finish(Error('Invalid filesystem write result'));return}
          offset+=count;this.bytesWritten+=count
          retries=count?0:retries+1
          if(retries>5){finish(Object.assign(new Error('File write made no progress'),{code:'ERR_SYSTEM_ERROR'}));return}
          if(offset<size){queueMicrotask(step);return}
          if(this.pos!==undefined)this.pos+=offset
          finish()
        }
        const buffers=[],remainingOffset=offset
        let skipped=0
        for(const chunk of chunks){
          const from=Math.max(0,remainingOffset-skipped);skipped+=chunk.byteLength
          if(from<chunk.byteLength)buffers.push(from?chunk.subarray(from):chunk)
        }
        try{
          if((vector||typeof entry.fs.write!=='function')&&typeof entry.fs.writev==='function')
            entry.fs.writev(this.fd,buffers,current,receive)
          else{
            const buffer=buffers.length===1?buffers[0]:Buffer.concat(buffers)
            entry.fs.write(this.fd,buffer,0,buffer.byteLength,current,receive)
          }
        }catch(error){finish(error)}
      }
      step()
    }
    _destroy(error,done){release(this,error,done)}
    close(callback){
      if(typeof callback==='function'){
        if(this.closed)queueMicrotask(callback)
        else this.once('close',callback)
      }
      if(!this.autoClose)this.once('finish',()=>this.destroy())
      this.end()
    }
    destroySoon(...args){return this.end(...args)}
  }
  return {ReadStream,WriteStream,createReadStream:(path,options)=>new ReadStream(path,options),
    createWriteStream:(path,options)=>new WriteStream(path,options)}
}
