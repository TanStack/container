const descriptorAPI=globalThis.__webContainerHost.fileDescriptorAPI??=(()=>{
  const task=async(operation,...args)=>{
    const boundary=globalThis.__webContainerHost.filesystemTask
    if(boundary)await boundary()
    return operation(...args)
  }
  const dispatch=callback=>{
    const host=globalThis.__webContainerHost
    const invoke=()=>globalThis[Symbol.for('web-container:task-queue')].task(callback)
    // Older backends retain their existing scheduling until they provide the
    // filesystem task capability. Kernel uses its real completion queue.
    if(!host.filesystemTask){queueMicrotask(invoke);return}
    host.filesystemTask().then(invoke).catch(error=>host.reportError(error))
  }
  const call=(method,...args)=>{
    const host=globalThis.__webContainerHost.descriptors
    if(!host)throw Object.assign(new Error('File descriptors are unavailable in this backend'),{code:'ERR_UNSUPPORTED_OPERATION'})
    return host.call(method,...args)
  }
  const invalid=message=>{throw Object.assign(new TypeError(message),{code:'ERR_INVALID_ARG_TYPE'})}
  const integer=(value,name)=>{
    if(!Number.isSafeInteger(value)||value<0)throw Object.assign(new RangeError('Invalid '+name),{code:'ERR_OUT_OF_RANGE'})
  }
  const view=value=>{
    if(!ArrayBuffer.isView(value))invalid('Expected a byte view')
    return new Uint8Array(value.buffer,value.byteOffset,value.byteLength)
  }
  const range=(buffer,offset,length)=>{
    integer(offset,'offset');integer(length,'length')
    if(offset>buffer.length||length>buffer.length-offset)throw Object.assign(new RangeError('Buffer range exceeds its length'),{code:'ERR_OUT_OF_RANGE'})
  }
  const positionCheck=position=>{if(position!==null)integer(position,'position')}
  function openSync(path,flags='r',mode=0o666){return call('open',filePath(path),flags,mode)}
  function closeSync(fd){call('close',fd)}
  function fstatSync(fd,options){
    return fsTypes.stats(call('stat',fd),options)
  }
  function ftruncateSync(fd,length=0){integer(length,'length');call('truncate',fd,length)}
  function readSync(fd,buffer,offset=0,length,position=null){
    const bytes=view(buffer)
    if(offset!==null&&typeof offset==='object')({offset=0,length,position=null}=offset)
    length??=bytes.length-offset
    range(bytes,offset,length);positionCheck(position)
    let read=0
    do{
      const result=call('read',fd,Math.min(65536,length-read),position===null?null:position+read).bytes
      bytes.set(result,offset+read);read+=result.length
      if(result.length<Math.min(65536,length-read+result.length))break
    }while(read<length)
    return read
  }
  function writeSync(fd,buffer,offset=0,length,position=null){
    if(typeof buffer==='string'){
      position=arguments[2]??null
      buffer=Buffer.from(buffer,length??'utf8');offset=0;length=buffer.length
    }
    const bytes=view(buffer)
    length??=bytes.length-offset
    range(bytes,offset,length);positionCheck(position)
    let written=0
    do{
      const chunk=bytes.subarray(offset+written,offset+Math.min(length,written+65536))
      const count=call('write',fd,Array.from(chunk),position===null?null:position+written)
      written+=count;if(count<chunk.length)break
    }while(written<length)
    return written
  }
  function read(fd,...args){
    const callback=args.pop();if(typeof callback!=='function')invalid('Expected callback')
    let buffer=args[0]
    if(!ArrayBuffer.isView(buffer)){
      const options=buffer??{};buffer=options.buffer??Buffer.alloc(16384);args=[buffer,options]
    }
    if(fd===0){
      let bytes,offset,length,position;
      try{
        bytes=view(buffer);offset=args[1]??0;length=args[2];position=args[3]??null;
        if(typeof offset==='object')({offset=0,length,position=null}=offset);
        length??=bytes.length-offset;range(bytes,offset,length);positionCheck(position);
        if(position!==null)throw Object.assign(Error('Cannot seek stdin'),{code:'ESPIPE'});
      }catch(error){dispatch(()=>callback(error));return}
      globalThis.__webContainerHost.proc.readInput(Math.min(length,65536),true).then(value=>{
        const count=value?.length??0;if(count)bytes.set(value,offset);globalThis[Symbol.for('web-container:task-queue')].task(callback,undefined,[null,count,buffer])
      },error=>globalThis[Symbol.for('web-container:task-queue')].task(callback,undefined,[error])).catch(error=>globalThis.__webContainerHost.reportError(error));
      return
    }
    dispatch(()=>{
      let count;try{count=readSync(fd,...args)}catch(error){callback(error);return}
      callback(null,count,buffer)
    })
  }
  function write(fd,...args){
    const callback=args.pop();if(typeof callback!=='function')invalid('Expected callback')
    const buffer=args[0]
    dispatch(()=>{
      let count;try{count=writeSync(fd,...args)}catch(error){callback(error);return}
      callback(null,count,buffer)
    })
  }
  function vectorViews(buffers){
    if(!Array.isArray(buffers))invalid('Expected an array of byte views')
    return Array.from(buffers,view)
  }
  function vector(fd,buffers,position,operation){
    const bytes=vectorViews(buffers)
    // Node treats positions other than nonnegative integers as the current offset.
    position=Number.isSafeInteger(position)&&position>=0?position:null
    let total=0
    for(const buffer of bytes){
      if(!buffer.length)continue
      const count=operation(fd,buffer,0,buffer.length,position===null?null:position+total)
      total+=count
      if(count<buffer.length)break
    }
    return total
  }
  const readvSync=(fd,buffers,position)=>vector(fd,buffers,position,readSync)
  const writevSync=(fd,buffers,position)=>vector(fd,buffers,position,writeSync)
  function vectorCallback(operation,fd,buffers,position,callback){
    if(typeof position==='function'){callback=position;position=undefined}
    if(typeof callback!=='function')invalid('Expected callback')
    const bytes=vectorViews(buffers)
    dispatch(()=>{
      let count;try{count=operation(fd,bytes,position)}catch(error){callback(error);return}
      callback(null,count,buffers)
    })
  }
  const readv=(fd,buffers,position,callback)=>vectorCallback(readvSync,fd,buffers,position,callback)
  const writev=(fd,buffers,position,callback)=>vectorCallback(writevSync,fd,buffers,position,callback)
  const custom=Symbol.for('nodejs.util.promisify.custom')
  read[custom]=(...args)=>new Promise((resolve,reject)=>read(...args,(error,bytesRead,buffer)=>error?reject(error):resolve({bytesRead,buffer})))
  write[custom]=(...args)=>new Promise((resolve,reject)=>write(...args,(error,bytesWritten,buffer)=>error?reject(error):resolve({bytesWritten,buffer})))
  readv[custom]=(...args)=>new Promise((resolve,reject)=>readv(...args,(error,bytesRead,buffers)=>error?reject(error):resolve({bytesRead,buffers})))
  writev[custom]=(...args)=>new Promise((resolve,reject)=>writev(...args,(error,bytesWritten,buffers)=>error?reject(error):resolve({bytesWritten,buffers})))
  return {openSync,closeSync,readSync,writeSync,readvSync,writevSync,vectorViews,fstatSync,ftruncateSync,read,write,readv,writev,task,dispatch}
})()
