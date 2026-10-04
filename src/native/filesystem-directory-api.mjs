import './disposal-symbols.mjs'
import {Buffer} from 'buffer'
import path from 'path-browserify'
import {DIRECTORY_OPEN,DIRECTORY_READ,DIRECTORY_CLOSE} from './filesystem-directory-protocol.mjs'

const failure=code=>Object.assign(new Error(code==='ERR_DIR_CLOSED'?'Directory handle was closed':'Cannot do synchronous work on directory handle with concurrent asynchronous operations'),{code})
function optionsFor(value){
  const options=typeof value==='string'?{encoding:value}:value??{}
  if(typeof options!=='object')throw Object.assign(new TypeError('Directory options must be an object or encoding'),{code:'ERR_INVALID_ARG_TYPE'})
  const {encoding='utf8',bufferSize=32,recursive=false}=options
  if(typeof bufferSize!=='number')throw Object.assign(new TypeError('Directory buffer size must be a number'),{code:'ERR_INVALID_ARG_TYPE'})
  if(!Number.isInteger(bufferSize)||bufferSize<1||bufferSize>0xffffffff)throw Object.assign(new RangeError('Directory buffer size must be a positive uint32'),{code:'ERR_OUT_OF_RANGE'})
  if(encoding!=='buffer'&&(typeof encoding!=='string'||!Buffer.isEncoding(encoding)))throw Object.assign(new TypeError('Invalid directory encoding'),{code:'ERR_INVALID_ARG_VALUE'})
  return {encoding,bufferSize,recursive}
}

// Only the filesystem service holds a backend Dir. The consumer owns Node's
// bounded entry buffer and callback lifetime, never a filesystem or inode.
export function createNativeDirectoryApi(filesystem,{normalizePath,displayPath,createAsyncResource,keepAlive}={}){
  const handles=new Set(),key={},shutdown=Symbol('directory shutdown')
  let disposed=false
  class Dir{
    #id;#path;#ownerPath;#options;#entries=[];#eof=false;#closed=false;#busy=false;#queue=[]
    constructor(secret,opened,original,options){
      if(secret!==key)throw new TypeError('Directory handles must be opened with opendir')
      this.#id=opened.id;this.#ownerPath=opened.path;this.#path=original;this.#options=options
      handles.add(this)
    }
    get path(){return this.#path}
    #assertSync(){if(this.#closed)throw failure('ERR_DIR_CLOSED');if(this.#busy)throw failure('ERR_DIR_CONCURRENT_OPERATION')}
    #read(){
      if(!this.#entries.length&&!this.#eof){
        const batch=filesystem[DIRECTORY_READ](this.#id,this.#options.bufferSize)
        this.#entries=batch.entries;this.#eof=batch.eof
      }
      const entry=this.#entries.shift()??null
      if(entry){
        if(entry.name?.type==='Buffer'&&Array.isArray(entry.name.data))entry.name=Buffer.from(entry.name.data)
        const suffix=path.relative(this.#ownerPath,String(entry.parentPath))
        const parent=suffix?path.join(String(this.#path),suffix):this.#path
        entry.parentPath=Buffer.isBuffer(this.#path)?Buffer.from(parent):parent
        if('path' in entry)entry.path=entry.parentPath
      }
      return entry
    }
    #close(){filesystem[DIRECTORY_CLOSE](this.#id);this.#closed=true;this.#entries=[];handles.delete(this)}
    readSync(){this.#assertSync();return this.#read()}
    closeSync(){this.#assertSync();this.#close()}
    #async(close,callback){
      if(callback===undefined)return new Promise((resolve,reject)=>this.#async(close,(error,value)=>error?reject(error):resolve(value)))
      if(!close&&this.#closed)throw failure('ERR_DIR_CLOSED')
      if(typeof callback!=='function')throw Object.assign(new TypeError('Callback must be a function'),{code:'ERR_INVALID_ARG_TYPE'})
      const resource=createAsyncResource?.('DIRHANDLE'),release=keepAlive?.()
      const deliver=(error,value)=>{
        try{if(resource)resource.runInAsyncScope(callback,undefined,error,value);else callback(error,value)}
        finally{try{resource?.emitDestroy()}finally{release?.()}}
      }
      const start=()=>{
        // Buffered reads do not hold the owner busy, just like Node's Dir.
        const blocking=close||!this.#entries.length
        if(blocking)this.#busy=true
        let buffered
        if(!blocking&&!this.#closed)buffered=this.#read()
        queueMicrotask(()=>{
          let error,value
          try{if(blocking&&this.#closed)throw failure('ERR_DIR_CLOSED');value=close?this.#close():blocking?this.#read():buffered}catch(cause){error=cause}
          finally{
            if(blocking){this.#busy=false;this.#queue.shift()?.()}
          }
          deliver(error,value)
        })
      }
      if(this.#busy)this.#queue.push(start);else start()
    }
    read(callback){return this.#async(false,callback)}
    close(callback){return this.#async(true,callback)}
    async *[Symbol.asyncIterator](){
      try{for(let entry;(entry=await this.read())!==null;)yield entry}
      finally{if(!this.#closed)await this.close()}
    }
    [Symbol.dispose](){if(!this.#closed)this.closeSync()}
    async [Symbol.asyncDispose](){if(!this.#closed)await this.close()}
    [shutdown](){if(!this.#closed)this.#close()}
  }
  return {Dir,
    opendirSync(original,value){
      if(disposed)throw Error('Directory client is disposed')
      const options=optionsFor(value),target=normalizePath(original),display=displayPath(original)
      return new Dir(key,filesystem[DIRECTORY_OPEN](target,options),display,options)
    },
    inspect:()=>({directories:handles.size}),
    dispose(){if(disposed)return;disposed=true;for(const handle of handles){
      // Consumer shutdown releases owner resources even during a queued read.
      // Pending callbacks settle on their normal queue with ERR_DIR_CLOSED.
      handle[shutdown]()
    }},
  }
}
