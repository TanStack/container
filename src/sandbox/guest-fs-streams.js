export class ReadStream extends Readable {
  constructor(path,options={}){
    if(typeof options==='string')options={encoding:options}
    const {start,end=Infinity,fd=null,autoClose=true}=options
    for(const [name,value] of [['start',start],['end',end]]){
      if(value!==undefined&&!(name==='end'&&value===Infinity)&&(!Number.isSafeInteger(value)||value<0))throw Object.assign(new RangeError('Invalid '+name),{code:'ERR_OUT_OF_RANGE'})
    }
    if(start!==undefined&&start>end)throw Object.assign(new RangeError('start exceeds end'),{code:'ERR_OUT_OF_RANGE'})
    if(fd!==null&&(!Number.isInteger(fd)||fd<0))throw Object.assign(new TypeError('Invalid fd'),{code:'ERR_INVALID_ARG_TYPE'})
    if(options.fs!==undefined)throw Object.assign(Error('Custom filesystem stream adapters are unavailable'),{code:'ERR_UNSUPPORTED_OPERATION'})
    super({...options,highWaterMark:options.highWaterMark??65536,autoDestroy:autoClose})
    this.path=fd===null?filePath(path):undefined
    this.fd=fd;this.flags=options.flags??'r';this.mode=options.mode??0o666
    this.start=start;this.end=end;this.pos=start;this.bytesRead=0
    this.autoClose=autoClose;this.pending=fd===null
  }
  _construct(callback){
    if(this.fd!==null){callback();return}
    open(this.path,this.flags,this.mode,(error,fd)=>{
      this.pending=false
      if(error){callback(error);return}
      this.fd=fd;this.emit('open',fd);this.emit('ready');callback()
    })
  }
  _read(size){
    const remaining=this.end===Infinity?Infinity:this.end-(this.pos??this.bytesRead)+1
    if(remaining<=0){this.push(null);return}
    const buffer=Buffer.alloc(Math.min(Math.max(size,1),65536,remaining))
    read(this.fd,buffer,0,buffer.length,this.pos??null,(error,count)=>{
      if(error){this.destroy(error);return}
      this.bytesRead+=count;if(this.pos!==undefined)this.pos+=count
      if(this.destroyed)return
      this.push(count?buffer.subarray(0,count):null)
    })
  }
  _destroy(error,callback){
    if(this.autoClose&&this.fd!==null){
      const fd=this.fd;this.fd=null
      try{closeSync(fd)}catch(closeError){error??=closeError}
    }
    callback(error)
  }
  close(callback){
    if(callback)this.once('close',callback)
    this.autoClose=true;this.destroy()
  }
}
export const createReadStream=(path,options)=>new ReadStream(path,options)

export class WriteStream extends Writable {
  constructor(path,options={}){
    if(typeof options==='string')options={encoding:options}
    options??={}
    const {start,fd=null,autoClose=true}=options
    if(start!==undefined&&(!Number.isSafeInteger(start)||start<0))throw Object.assign(new RangeError('Invalid start'),{code:'ERR_OUT_OF_RANGE'})
    if(fd!==null&&(!Number.isInteger(fd)||fd<0))throw Object.assign(new TypeError('Invalid fd'),{code:'ERR_INVALID_ARG_TYPE'})
    if(options.fs!==undefined||options.flush)throw Object.assign(Error('Custom filesystem adapters and durable flush are unavailable'),{code:'ERR_UNSUPPORTED_OPERATION'})
    const resolvedPath=fd===null?filePath(path):undefined
    super({...options,decodeStrings:true,autoDestroy:autoClose})
    this.path=resolvedPath
    this.fd=fd;this.flags=options.flags??'w';this.mode=options.mode??0o666
    this.start=start;this.pos=start;this.bytesWritten=0;this.autoClose=autoClose
    this._ioPending=false;this._afterIO=null
    if(options.encoding)this.setDefaultEncoding(options.encoding)
  }
  get pending(){return this.fd===null}
  get autoClose(){return this._writableState.autoDestroy}
  set autoClose(value){this._writableState.autoDestroy=value}
  _construct(callback){
    if(this.fd!==null){callback();return}
    open(this.path,this.flags,this.mode,(error,fd)=>{
      if(error){callback(error);return}
      this.fd=fd;this.emit('open',fd);this.emit('ready');callback()
    })
  }
  _write(data,encoding,callback){
    let offset=0
    const position=this.pos
    if(this.pos!==undefined)this.pos+=data.length
    this._ioPending=true
    const complete=error=>{
      this._ioPending=false
      callback(error)
      const after=this._afterIO;this._afterIO=null
      if(after)after(error)
    }
    const next=()=>write(this.fd,data,offset,data.length-offset,position===undefined?null:position+offset,(error,count)=>{
      if(error){complete(error);return}
      if(this.destroyed){complete(Object.assign(Error('Stream destroyed during write'),{code:'ERR_STREAM_DESTROYED'}));return}
      this.bytesWritten+=count;offset+=count
      if(offset===data.length){complete();return}
      if(!count){complete(Object.assign(Error('File write made no progress'),{code:'EIO'}));return}
      next()
    })
    next()
  }
  _destroy(error,callback){
    const close=ioError=>{
      error??=ioError
      if(this.fd!==null){
        const fd=this.fd;this.fd=null
        try{closeSync(fd)}catch(closeError){error??=closeError}
      }
      callback(error)
    }
    // A descriptor must not close while its queued write still owns it.
    if(this._ioPending)this._afterIO=close
    else close()
  }
  close(callback){
    if(callback){if(this.closed){queueMicrotask(callback);return}this.once('close',callback)}
    if(!this.autoClose)this.once('finish',()=>this.destroy())
    this.end()
  }
  destroySoon(...args){return this.end(...args)}
}
export const createWriteStream=(path,options)=>new WriteStream(path,options)
