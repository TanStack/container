import {WATCH_OPEN,WATCH_CONTROL,WATCH_EVENT} from './filesystem-watch-protocol.mjs'
import {DIRECTORY_OPEN,DIRECTORY_READ,DIRECTORY_CLOSE} from './filesystem-directory-protocol.mjs'
import {WRITE_FILE_WITH_PARENTS} from './filesystem-write-protocol.mjs'
import {writeFileWithParents} from './write-file-with-parents.mjs'

const CONNECT='tanstack-wasi-filesystem-connect',RELEASE='tanstack-wasi-filesystem-release'
const pathWrites=new Set(['appendFileSync','writeFileSync','mkdirSync','unlinkSync','rmSync','rmdirSync',
  'chmodSync','chownSync','lchmodSync','lchownSync','utimesSync','lutimesSync','truncateSync'])
const descriptorWrites=new Set(['writeSync','writevSync','fchmodSync','fchownSync','futimesSync','ftruncateSync'])

// Run this in a worker that does not execute guest code or native compilers.
// Every endpoint uses the same filesystem and the caller's pinned wire codec.
export function createWasiFilesystemService(fs,createHandler,{maxPendingWatchEvents=1024}={}){
  if(!Number.isSafeInteger(maxPendingWatchEvents)||maxPendingWatchEvents<1)
    throw RangeError('Filesystem watcher queue limit must be a positive integer')
  const clients=new Map()
  const descriptorPaths=new Map()
  // Codecs can differ between compiler packages, ownership cannot. Select the
  // endpoint's codec inside this service, not by creating another service.
  const codecs=typeof createHandler==='function'?undefined:new Map(Object.entries(createHandler??{}))
  if(codecs&&(!codecs.size||[...codecs].some(([name,handler])=>!name||typeof handler!=='function')))
    throw TypeError('Filesystem codecs must name handler factories')
  let disposed=false
  function release(id){
    const client=clients.get(id)
    if(!client)return
    const parent=[...clients.keys()].filter(name=>name!==id&&id.startsWith(name+'/')).sort((a,b)=>b.length-a.length)[0]
    if(parent)for(const path of client.changedPaths)clients.get(parent).changedPaths.add(path)
    clients.delete(id)
    client.handler.dispose()
    client.port.removeEventListener('message',client.listener)
    for(const state of client.watches.values())state.watcher.close()
    client.watches.clear()
    for(const state of client.directories.values())try{state.directory.closeSync()}catch{}
    client.directories.clear()
    client.port.close()
    for(const descriptor of client.descriptors){
      try{fs.closeSync(descriptor)}catch{}
      descriptorPaths.delete(descriptor)
    }
    client.descriptors.clear()
  }
  function onMessage({data}){
    if(data?.type===RELEASE){release(data.id);return}
    if(data?.type!==CONNECT)return
    const {id,port,codec}=data
    const factory=codecs?codecs.get(codec):codec===undefined?createHandler:undefined
    if(disposed||typeof id!=='string'||!id||clients.has(id)||typeof factory!=='function'){
      port?.close();throw new Error('Invalid WASI filesystem endpoint')
    }
    if(!port||typeof port.addEventListener!=='function')throw new TypeError('Invalid filesystem endpoint port')
    const descriptors=new Set(),watches=new Map(),changedPaths=new Set(),directories=new Map(),methods=new Map()
    let nextDirectory=0
    const endpoint=new Proxy(fs,{get(target,method){
      if(method===WRITE_FILE_WITH_PARENTS)return (path,contents,options)=>
        writeFileWithParents(endpoint,path,contents,options)
      if(method===DIRECTORY_OPEN)return (path,options)=>{
        const directory=fs.opendirSync(path,options),directoryId=++nextDirectory
        directories.set(directoryId,{directory,eof:false})
        return {id:directoryId,path:directory.path}
      }
      if(method===DIRECTORY_READ)return (directoryId,size)=>{
        const state=directories.get(directoryId)
        if(!state)throw Object.assign(new Error('Directory handle was closed'),{code:'ERR_DIR_CLOSED'})
        if(!Number.isInteger(size)||size<1||size>0xffffffff)throw RangeError('Invalid directory buffer size')
        const entries=[]
        while(!state.eof&&entries.length<size){
          const entry=state.directory.readSync()
          if(entry===null)state.eof=true;else entries.push(entry)
        }
        return {entries,eof:state.eof}
      }
      if(method===DIRECTORY_CLOSE)return directoryId=>{
        const state=directories.get(directoryId)
        if(!state)throw Object.assign(new Error('Directory handle was closed'),{code:'ERR_DIR_CLOSED'})
        state.directory.closeSync();directories.delete(directoryId)
      }
      if(method==='__tanstackFilesystemChanges')return prefix=>{
        if(typeof prefix!=='string'||!prefix)throw TypeError('Invalid filesystem change scope')
        return [...new Set([...clients].filter(([name])=>name===prefix||name.startsWith(prefix+'/'))
          .flatMap(([,client])=>[...client.changedPaths]))].filter(name=>name==='/app'||name.startsWith('/app/')).sort()
      }
      if(method===WATCH_OPEN)return (watchId,path,options)=>{
        if(!Number.isSafeInteger(watchId)||watchId<1||watches.has(watchId))throw Error('Invalid filesystem watch id')
        const notify=message=>port.postMessage({type:WATCH_EVENT,id:watchId,...message})
        const state={watcher:undefined,closed:false,inFlight:0,sequence:0,pending:new Map()}
        const send=message=>{
          state.sequence=state.sequence===Number.MAX_SAFE_INTEGER?1:state.sequence+1
          state.inFlight=state.sequence;notify({...message,sequence:state.sequence})
        }
        const fail=error=>{
          try{notify({event:'error',error:{name:error.name,message:error.message,code:error.code,errno:error.errno,syscall:error.syscall,path:error.path}})}
          finally{state.watcher.close()}
        }
        state.watcher=fs.watch(path,options,(change,filename)=>{
          if(state.closed)return
          const message={event:'change',change,filename}
          if(!state.inFlight){send(message);return}
          // Repeated notifications of the same kind and path may coalesce,
          // just as native watch queues do. Distinct paths are never dropped.
          const name=ArrayBuffer.isView(filename)?Array.from(new Uint8Array(filename.buffer,filename.byteOffset,filename.byteLength)).join(','):filename
          const key=change+':'+name
          if(!state.pending.has(key)&&state.pending.size>=maxPendingWatchEvents){
            fail(Object.assign(new Error('Filesystem watcher queue limit exceeded'),{code:'ENOSPC',syscall:'watch',path}));return
          }
          state.pending.set(key,message)
        })
        watches.set(watchId,state)
        state.watcher.on('close',()=>{
          state.closed=true;state.inFlight=0;state.pending.clear();watches.delete(watchId);notify({event:'close'})
        })
        state.watcher.on('error',fail)
      }
      const value=Reflect.get(target,method)
      if(typeof value!=='function'||['Stats','Dirent'].includes(method))return value
      // Codecs inspect the public methods while encoding constructor metadata.
      // Reuse only method wrappers, never file data, stats or descriptor state.
      const cached=methods.get(method)
      if(cached?.value===value)return cached.wrapper
      const wrapper=(...args)=>{
        const result=Reflect.apply(value,target,args)
        if(method==='openSync'){
          descriptors.add(result);descriptorPaths.set(result,String(args[0]))
          const flags=args[1]
          if(typeof flags==='string'?/[wax]/.test(flags):typeof flags==='number'&&flags&(fs.constants.O_CREAT|fs.constants.O_TRUNC))
            changedPaths.add(String(args[0]))
        }
        if(method==='closeSync'){
          for(const client of clients.values())client.descriptors.delete(args[0])
          descriptorPaths.delete(args[0])
        }
        const mark=path=>{if(path!==undefined)changedPaths.add(String(path))}
        if(pathWrites.has(method))mark(typeof args[0]==='number'?descriptorPaths.get(args[0]):args[0])
        if(descriptorWrites.has(method))mark(descriptorPaths.get(args[0]))
        if(method==='renameSync'){mark(args[0]);mark(args[1])}
        if(['copyFileSync','cpSync','linkSync','symlinkSync'].includes(method))mark(args[1])
        if(method==='mkdtempSync')mark(result)
        return result
      }
      methods.set(method,{value,wrapper})
      return wrapper
    }})
    let handler
    try{handler=factory(endpoint)}catch(error){port.close();throw error}
    if(typeof handler!=='function'||typeof handler.dispose!=='function'){
      port.close();throw TypeError('Filesystem codec must return a disposable handler')
    }
    const listener=event=>{
      const data=event.data
      if(data?.type===WATCH_CONTROL){
        const state=watches.get(data.id)
        if(!state)return
        if(data.action==='close'){watches.delete(data.id);state.watcher.close()}
        else if(data.action==='ref')state.watcher.ref?.()
        else if(data.action==='unref')state.watcher.unref?.()
        else if(data.action==='ack'&&state.inFlight===data.sequence){
          state.inFlight=0
          const next=state.pending.entries().next()
          if(!next.done){
            const [key,message]=next.value;state.pending.delete(key)
            state.sequence=state.sequence===Number.MAX_SAFE_INTEGER?1:state.sequence+1
            state.inFlight=state.sequence
            port.postMessage({type:WATCH_EVENT,id:data.id,...message,sequence:state.sequence})
          }
        }
        return
      }
      handler(event)
    }
    clients.set(id,{port,handler,listener,descriptors,watches,changedPaths,directories})
    port.addEventListener('message',listener);port.start()
  }
  return {onMessage,release,
    releaseScope(prefix){
      if(typeof prefix!=='string'||!prefix)throw TypeError('Invalid filesystem endpoint scope')
      for(const id of [...clients.keys()])if(id===prefix||id.startsWith(prefix+'/'))release(id)
    },
    inspectWatchers:()=>{
      const states=[...clients.values()].flatMap(client=>[...client.watches.values()])
      return {watches:states.length,pendingEvents:states.reduce((count,state)=>count+state.pending.size,0),
        inFlightEvents:states.filter(state=>state.inFlight).length}
    },
    inspectDirectories:()=>({directories:[...clients.values()].reduce((n,c)=>n+c.directories.size,0)}),
    inspect:()=>({disposed,clients:clients.size,descriptors:[...clients.values()].reduce((n,c)=>n+c.descriptors.size,0)}),
    dispose(){if(disposed)return;disposed=true;for(const id of clients.keys())release(id)},
  }
}

export function createWasiFilesystemEndpoint(control,id,{codec}={}){
  if(typeof id!=='string'||!id)throw new TypeError('Invalid filesystem endpoint id')
  if(codec!==undefined&&(typeof codec!=='string'||!codec))throw new TypeError('Invalid filesystem codec name')
  const {port1,port2}=new MessageChannel()
  try{control.postMessage({type:CONNECT,id,port:port2,...(codec===undefined?{}:{codec})},[port2])}
  catch(error){port1.close();port2.close();throw error}
  let disposed=false
  return {port:port1,dispose(){
    if(disposed)return;disposed=true
    try{control.postMessage({type:RELEASE,id})}finally{port1.close()}
  }}
}
