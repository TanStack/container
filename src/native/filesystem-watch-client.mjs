import {EventEmitter as DefaultEventEmitter} from 'events'
import {Buffer} from 'buffer'
import {WATCH_OPEN,WATCH_CONTROL,WATCH_EVENT} from './filesystem-watch-protocol.mjs'

// File calls stay synchronous, notifications arrive on the same endpoint later.
// This client does not own the port, disposing it leaves ordinary file calls alone.
export function createNativeFilesystemWatchClient(filesystem,port,
  {EventEmitter=DefaultEventEmitter,createAsyncResource,keepAlive,signal}={}){
  if(signal!==undefined&&!(signal instanceof AbortSignal))throw TypeError('Watch client signal must be an AbortSignal')
  const watches=new Map()
  const activate=Symbol('activate watcher'),failed=Symbol('failed watcher creation')
  let next=0,disposed=false
  class FSWatcher extends EventEmitter{
    #id;#closed=false;#resource;#signal;#abort;#persistent;#release
    constructor(id,signal,persistent){
      super();this.#id=id;this.#signal=signal;this.#persistent=persistent
      this.#resource=createAsyncResource?.('FSWATCHER')
      this.#abort=()=>this.close()
    }
    emit(event,...args){
      return this.#resource?this.#resource.runInAsyncScope(super.emit,this,event,...args):super.emit(event,...args)
    }
    close(){
      if(this.#closed)return
      this.#closed=true;watches.delete(this.#id)
      this.#signal?.removeEventListener('abort',this.#abort)
      this.#release?.();this.#release=undefined
      try{if(this.#id!==undefined)port.postMessage({type:WATCH_CONTROL,id:this.#id,action:'close'})}
      finally{queueMicrotask(()=>{try{this.emit('close')}finally{this.#resource?.emitDestroy()}})}
    }
    ref(){
      if(!this.#closed&&this.#id!==undefined){this.#release??=keepAlive?.();port.postMessage({type:WATCH_CONTROL,id:this.#id,action:'ref'})}
      return this
    }
    unref(){
      this.#release?.();this.#release=undefined
      if(!this.#closed&&this.#id!==undefined)port.postMessage({type:WATCH_CONTROL,id:this.#id,action:'unref'})
      return this
    }
    [activate](){
      this.#signal?.addEventListener('abort',this.#abort,{once:true})
      if(this.#signal?.aborted)this.close()
      else if(this.#persistent)this.ref()
    }
    [failed](){this.#closed=true;this.#resource?.emitDestroy()}
  }
  function receive({data}){
    if(data?.type!==WATCH_EVENT)return
    const entry=watches.get(data.id)
    if(!entry)return
    if(data.event==='close'){entry.watcher.close();return}
    if(data.event==='error'){
      const error=Object.assign(new Error(data.error?.message??'Filesystem watch failed'),data.error)
      try{entry.watcher.emit('error',error)}finally{entry.watcher.close()}
    }else if(data.event==='change'&&['change','rename'].includes(data.change)){
      const filename=entry.encoding==='buffer'&&data.filename!==null?
        Buffer.from(data.filename):data.filename
      try{entry.watcher.emit('change',data.change,filename)}
      finally{port.postMessage({type:WATCH_CONTROL,id:data.id,action:'ack',sequence:data.sequence})}
    }
  }
  port.addEventListener('message',receive);port.start()
  function watch(path,options,listener){
    if(disposed)throw Error('Filesystem watch client is disposed')
    if(typeof options==='function'){listener=options;options={}}
    if(typeof options==='string')options={encoding:options}
    if(options===null||options===undefined)options={}
    if(typeof options!=='object'||Array.isArray(options))throw TypeError('Invalid filesystem watch options')
    if(listener!==undefined&&typeof listener!=='function')throw TypeError('Watch listener must be a function')
    const {signal,encoding='utf8',persistent=true,recursive=false}=options
    if(signal!==undefined&&!(signal instanceof AbortSignal))throw TypeError('Watch signal must be an AbortSignal')
    if(encoding!=='buffer'&&!Buffer.isEncoding(encoding))throw TypeError('Invalid watch encoding')
    do{next=next===Number.MAX_SAFE_INTEGER?1:next+1}while(watches.has(next))
    const id=next,watcher=new FSWatcher(id,signal,persistent)
    if(listener)watcher.on('change',listener)
    watches.set(id,{watcher,encoding})
    try{filesystem[WATCH_OPEN](id,path,{encoding,persistent,recursive})}
    catch(error){watches.delete(id);watcher[failed]();throw error}
    watcher[activate]()
    return watcher
  }
  const abort=()=>client.dispose()
  const client={watch,FSWatcher,
    inspect:()=>({disposed,watches:watches.size}),
    dispose(){
      if(disposed)return
      disposed=true
      signal?.removeEventListener('abort',abort)
      port.removeEventListener('message',receive)
      for(const {watcher} of [...watches.values()])watcher.close()
    },
  }
  signal?.addEventListener('abort',abort,{once:true})
  if(signal?.aborted)client.dispose()
  return client
}
