import {Buffer} from 'buffer'
import path from 'path-browserify'
import {File,Superblock,createError,validateFd} from '@jsonjoy.com/fs-core'
import {Volume,createFsFromVolume,fs as filesystem} from 'memfs'

const {O_APPEND,O_RDONLY,O_WRONLY,O_RDWR}=filesystem.constants
const implicitPosition=position=>typeof position!=='number'||position===-1

// A positioned operation has its own offset, it does not seek the descriptor.
// Keep this in the storage layer so every public filesystem API shares the rule.
class NativeFile extends File{
  constructor(...args){super(...args);this.position=0}
  read(buffer,offset=0,length=buffer.byteLength,position){
    if((this.flags&(O_WRONLY|O_RDWR))===O_WRONLY)
      throw createError('EBADF','read',this.link.getPath())
    if(this.node.isDirectory())throw createError('EISDIR','read',this.link.getPath())
    const implicit=implicitPosition(position),start=implicit?this.position:position
    const bytes=this.node.read(buffer,offset,length,start)
    if(implicit&&bytes)this.position=start+bytes
    return bytes
  }
  write(buffer,offset=0,length=buffer.byteLength,position){
    if((this.flags&(O_WRONLY|O_RDWR))===O_RDONLY)
      throw createError('EBADF','write',this.link.getPath())
    if(!length)return 0
    const implicit=implicitPosition(position)
    // The container has Linux-style append semantics, independent of host OS.
    const start=this.flags&O_APPEND?this.node.getSize():implicit?this.position:position
    const bytes=this.node.write(Buffer.from(buffer.buffer,buffer.byteOffset,buffer.byteLength),offset,length,start)
    if(implicit&&bytes)this.position=start+bytes
    return bytes
  }
}

class NativeSuperblock extends Superblock{
  openLink(...args){
    // The public open hook retains memfs permissions, truncation and ownership.
    const opened=super.openLink(...args)
    const file=new NativeFile(opened.link,opened.node,opened.flags,opened.fd)
    this.fds[file.fd]=file
    return file
  }
  readv=(fd,buffers,position)=>{
    this.getFileByFdOrThrow(fd)
    let cursor=implicitPosition(position)?undefined:position,total=0
    for(const buffer of buffers){
      const bytes=this.read(fd,buffer,0,buffer.byteLength,cursor)
      if(cursor!==undefined)cursor+=bytes
      total+=bytes
      if(bytes<buffer.byteLength)break
    }
    return total
  }
  writeVector(fd,buffers,position){
    this.getFileByFdOrThrow(fd)
    let cursor=implicitPosition(position)?undefined:position,total=0
    for(const buffer of buffers){
      const bytes=this.write(fd,buffer,0,buffer.byteLength,cursor)
      if(cursor!==undefined)cursor+=bytes
      total+=bytes
      if(bytes<buffer.byteLength)break
    }
    return total
  }
}

class NativeVolume extends Volume{
  constructor(options){
    super(new NativeSuperblock(options))
    const statSync=this.statSync
    this.statSync=(target,options)=>{
      try{return Reflect.apply(statSync,this,[target,options])}
      catch(error){
        // Node's optional stat treats a non-directory parent as a missing
        // target. Optional lstat deliberately retains its ENOTDIR error.
        if(error?.code==='ENOTDIR'&&options?.throwIfNoEntry===false)return undefined
        throw error
      }
    }
    const globSync=this.globSync
    this.globSync=(pattern,options={})=>{
      const patterns=Array.isArray(pattern)?pattern:[pattern]
      if(patterns.some(value=>typeof value!=='string'))
        throw Object.assign(new TypeError('Glob patterns must be strings'),{code:'ERR_INVALID_ARG_TYPE'})
      let cwd=options.cwd??globalThis.process?.cwd?.()??'/'
      if(cwd instanceof URL){
        if(cwd.protocol!=='file:')throw Object.assign(new TypeError('File URL required'),{code:'ERR_INVALID_URL_SCHEME'})
        if(cwd.hostname&&cwd.hostname!=='localhost')throw Object.assign(new TypeError('Local file URL required'),{code:'ERR_INVALID_FILE_URL_HOST'})
        if(/%2f|%5c/i.test(cwd.pathname))throw Object.assign(new TypeError('Encoded path separator in file URL'),{code:'ERR_INVALID_FILE_URL_PATH'})
        cwd=decodeURIComponent(cwd.pathname)
      }
      if(Buffer.isBuffer(cwd))cwd=cwd.toString('utf8')
      const entries=[...new Set(patterns.flatMap(value=>globSync(value,{...options,cwd,withFileTypes:false})))]
      if(!options?.withFileTypes)return entries
      return entries.map(name=>{
        const absolute=path.resolve(cwd,name),directory=path.dirname(absolute),leaf=path.basename(absolute)
        return this.readdirSync(directory,{withFileTypes:true}).find(entry=>String(entry.name)===leaf)
      }).filter(Boolean)
    }
    this.glob=(pattern,...args)=>{
      const callback=args.pop(),options=args[0]
      if(typeof callback!=='function')throw TypeError('Callback must be a function')
      queueMicrotask(()=>{
        let values
        try{values=this.globSync(pattern,options)}catch(error){callback(error);return}
        callback(null,values)
      })
    }
    // Volume installs these public methods on each instance, not its prototype.
    const readFileSync=this.readFileSync,writeFileSync=this.writeFileSync,appendFileSync=this.appendFileSync
    this.readFileSync=(id,options)=>typeof id==='number'?this.#readDescriptor(id,options):readFileSync(id,options)
    this.writeFileSync=(id,data,options)=>typeof id==='number'?this.#writeDescriptor(id,data,options):writeFileSync(id,data,options)
    this.appendFileSync=(id,data,options)=>typeof id==='number'?this.#writeDescriptor(id,data,options):appendFileSync(id,data,options)
    for(const method of ['readFile','writeFile','appendFile']){
      const original=this[method]
      this[method]=(id,...args)=>{
        if(typeof id!=='number')return original(id,...args)
        const callback=args.pop()
        if(typeof callback!=='function')throw TypeError('Callback must be a function')
        queueMicrotask(()=>{
          let result
          try{result=this[method+'Sync'](id,...args)}catch(error){callback(error);return}
          if(method==='readFile')callback(null,result)
          else callback(null)
        })
      }
    }
  }
  #readDescriptor(id,options){
    const encoding=fileEncoding(options),chunks=[]
    for(;;){
      const buffer=Buffer.alloc(65536),count=this.readSync(id,buffer,0,buffer.length,null)
      if(!count)break
      chunks.push(buffer.subarray(0,count))
    }
    const bytes=Buffer.concat(chunks)
    return encoding?bytes.toString(encoding):bytes
  }
  #writeDescriptor(id,data,options){
    const encoding=fileEncoding(options)
    const bytes=typeof data==='string'?Buffer.from(data,encoding??'utf8'):
      ArrayBuffer.isView(data)?Buffer.from(data.buffer,data.byteOffset,data.byteLength):undefined
    if(!bytes)throw TypeError('File contents must be a string or ArrayBuffer view')
    let offset=0
    do{
      const count=this.writeSync(id,bytes,offset,bytes.length-offset,null)
      if(!count&&offset<bytes.length)throw Error('File write made no progress')
      offset+=count
    }while(offset<bytes.length)
  }
  // Volume's private vector helper assumes positioned scalar I/O seeks the fd.
  // Override the public APIs instead of depending on that private helper.
  writevSync=(fd,buffers,position)=>{
    validateFd(fd)
    return this._core.writeVector(fd,buffers,position)
  }
  writev=(fd,buffers,position,callback)=>{
    if(typeof position==='function'){callback=position;position=null}
    if(typeof callback!=='function')throw TypeError('Callback must be a function')
    queueMicrotask(()=>{
      let bytes
      try{validateFd(fd);bytes=this._core.writeVector(fd,buffers,position)}
      catch(error){callback(error);return}
      callback(null,bytes,buffers)
    })
  }
}

function fileEncoding(options){
  if(options!==undefined&&options!==null&&typeof options!=='string'&&(typeof options!=='object'||Array.isArray(options)))
    throw TypeError('File options must be a string or object')
  const encoding=typeof options==='string'?options:options?.encoding
  if(encoding!==undefined&&encoding!==null&&!Buffer.isEncoding(encoding))throw TypeError('Invalid file encoding')
  return encoding
}

export function createNativeFilesystemBackend(files={},cwd='/'){
  const vol=new NativeVolume()
  vol.fromJSON(files,cwd)
  const fs=createFsFromVolume(vol)
  // The maintained promise wrapper returns a Promise of an array for glob.
  // Expose the Node async-iterator contract on our own filesystem instance.
  fs.promises.glob=async function*(pattern,options){yield*vol.globSync(pattern,options)}
  return {fs,vol}
}
