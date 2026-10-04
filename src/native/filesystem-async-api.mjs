import './disposal-symbols.mjs'
import {Buffer} from 'buffer'
import {EventEmitter} from 'events'
import {createNativeFilesystemStreamApi} from './filesystem-stream-api.mjs'

const valueMethods=['fstat','stat','lstat','statfs','readdir','readFile','readlink','realpath','mkdir','mkdtemp','open','opendir','glob']
const voidMethods=['access','appendFile','chmod','chown','close','copyFile','cp','fchmod','fchown','fdatasync','fsync',
  'ftruncate','futimes','lchmod','lchown','link','rename','rmdir','rm','symlink','truncate','unlink','utimes','lutimes','writeFile']

// Async APIs use public operations on the caller's filesystem. There is no
// Volume, private core, descriptor shadow cursor or separate file storage here.
export function createNativeFilesystemAsyncApi(fs,{createAsyncResource,keepAlive}={}){
  const callbacks={},promises={}
  function schedule(callback,operation){
    if(typeof callback!=='function')throw TypeError('Callback must be a function')
    const resource=createAsyncResource?.('FSREQCALLBACK')
    const release=keepAlive?.()
    queueMicrotask(()=>{
      const invoke=(...args)=>resource?resource.runInAsyncScope(callback,undefined,...args):callback(...args)
      try{
        let values
        try{values=operation()}catch(error){invoke(error);return}
        invoke(null,...values)
      }finally{try{resource?.emitDestroy()}finally{release?.()}}
    })
  }
  for(const [methods,returnsValue] of [[valueMethods,true],[voidMethods,false]]){
    for(const name of methods){
      const method=fs[name+'Sync']
      if(typeof method!=='function')continue
      callbacks[name]=(...args)=>{
        const callback=args.pop()
        schedule(callback,()=>{const result=Reflect.apply(method,fs,args);return returnsValue?[result]:[]})
      }
      promises[name]=(...args)=>new Promise((resolve,reject)=>{
        callbacks[name](...args,(error,value)=>error?reject(error):resolve(value))
      })
    }
  }
  callbacks.exists=(path,callback)=>{
    if(typeof callback!=='function')throw TypeError('Callback must be a function')
    // exists is the legacy callback API without an error argument.
    schedule((error,value)=>callback(!error&&value),()=>[fs.existsSync(path)])
  }
  callbacks.read=(fd,...args)=>{
    const callback=args.pop()
    let buffer,offset,length,position
    if(ArrayBuffer.isView(args[0])){
      buffer=args[0]
      if(args[1]!==null&&typeof args[1]==='object')({offset=0,length=buffer.byteLength-offset,position=null}=args[1])
      else [offset=0,length=buffer.byteLength-offset,position=null]=args.slice(1)
    }else{
      const options=args[0]??{}
      ;({buffer=Buffer.alloc(16384),offset=0,length=buffer.byteLength-offset,position=null}=options)
    }
    schedule(callback,()=>[fs.readSync(fd,buffer,offset,length,position),buffer])
  }
  callbacks.write=(fd,data,...args)=>{
    const callback=args.pop()
    schedule(callback,()=>{
      let written
      if(typeof data==='string')written=fs.writeSync(fd,data,args[0]??null,args[1]??'utf8')
      else if(args[0]!==null&&typeof args[0]==='object'){
        const {offset=0,length=data.byteLength-offset,position=null}=args[0]
        written=fs.writeSync(fd,data,offset,length,position)
      }else{
        const [offset=0,length=data.byteLength-offset,position=null]=args
        written=fs.writeSync(fd,data,offset,length,position)
      }
      return [written,data]
    })
  }
  for(const name of ['readv','writev'])callbacks[name]=(fd,buffers,position,callback)=>{
    if(typeof position==='function'){callback=position;position=null}
    schedule(callback,()=>[fs[name+'Sync'](fd,buffers,position??null),buffers])
  }
  if(callbacks.realpath)callbacks.realpath.native=callbacks.realpath
  Object.assign(callbacks,createNativeFilesystemStreamApi(callbacks,{keepAlive}))
  const result=(name,args,map)=>new Promise((resolve,reject)=>{
    callbacks[name](...args,(error,...values)=>error?reject(error):resolve(map?map(...values):values[0]))
  })
  if(callbacks.glob)promises.glob=async function*(pattern,options){
    yield*await result('glob',[pattern,options])
  }
  class FileHandle extends EventEmitter{
    #fd;#closing
    constructor(fd){super();this.#fd=fd}
    get fd(){return this.#fd}
    #active(){
      if(this.#fd===-1||this.#closing)throw Object.assign(new Error('File handle is closed'),{code:'EBADF'})
      return this.#fd
    }
    #call(name,args=[],map){
      try{return result(name,[this.#active(),...args],map)}catch(error){return Promise.reject(error)}
    }
    close(){
      if(this.#closing)return this.#closing
      if(this.#fd===-1)return Promise.resolve()
      const fd=this.#fd
      this.#fd=-1
      this.#closing=result('close',[fd]).then(()=>{this.emit('close')}).finally(()=>{this.#closing=undefined})
      return this.#closing
    }
    read(...args){return this.#call('read',args,(bytesRead,buffer)=>({bytesRead,buffer}))}
    write(...args){return this.#call('write',args,(bytesWritten,buffer)=>({bytesWritten,buffer}))}
    readv(buffers,position){return this.#call('readv',[buffers,position],(bytesRead,buffers)=>({bytesRead,buffers}))}
    writev(buffers,position){return this.#call('writev',[buffers,position],(bytesWritten,buffers)=>({bytesWritten,buffers}))}
    readFile(options){return this.#call('readFile',[options])}
    writeFile(data,options){return this.#call('writeFile',[data,options])}
    appendFile(data,options){return this.#call('appendFile',[data,options])}
    stat(options){return this.#call('fstat',[options])}
    chmod(mode){return this.#call('fchmod',[mode])}
    chown(uid,gid){return this.#call('fchown',[uid,gid])}
    truncate(length=0){return this.#call('ftruncate',[length])}
    utimes(atime,mtime){return this.#call('futimes',[atime,mtime])}
    sync(){return this.#call('fsync')}
    datasync(){return this.#call('fdatasync')}
    async [Symbol.asyncDispose](){await this.close()}
  }
  promises.constants=fs.constants
  promises.open=async(path,flags='r',mode)=>new FileHandle(await result('open',[path,flags,mode]))
  for(const name of ['readFile','writeFile','appendFile']){
    const method=promises[name]
    if(method)promises[name]=(path,...args)=>{
      if(path instanceof FileHandle)return path[name](...args)
      return method(path,...args)
    }
  }
  return {callbacks,promises,FileHandle}
}
