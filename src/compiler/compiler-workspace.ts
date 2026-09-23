import type {WorkspaceFileSessions} from '../sandbox/workspace-file-sessions'
import type {WorkspaceStat} from '../sandbox/files'

type Callback=(error:Error|null,value?:any,buffer?:Uint8Array)=>void
type Call=(method:string,args:unknown[])=>Promise<unknown>
const failure=(code:string,message:string)=>Object.assign(Error(message),{code})
const ioError=(error:unknown)=>{
  const result=error instanceof Error?error:Error(String(error))
  return Object.assign(result,{code:(result as Error&{code?:string}).code??/^(E[A-Z]+):/.exec(result.message)?.[1]??'EIO'})
}

/** Experimental owner-side endpoint. A live lease, never a workspace snapshot. */
export class CompilerWorkspace {
  #lease:ReturnType<WorkspaceFileSessions['open']>
  #closed=false
  #pending=0
  constructor(sessions:WorkspaceFileSessions,writable:boolean){this.#lease=sessions.open(writable)}
  async call(method:string,args:unknown[]):Promise<unknown>{
    if(this.#closed)throw failure('EBADF','Compiler workspace closed')
    if(this.#pending>=64)throw failure('EAGAIN','Compiler filesystem queue full')
    this.#pending++
    try{
      // Yield before dispatch so lease revocation also cancels queued work.
      await Promise.resolve()
      if(this.#closed)throw failure('EBADF','Compiler workspace closed')
      if(!Array.isArray(args))throw failure('EINVAL','Expected filesystem arguments')
      if(!['open','read','write','close','stat','lstat','fstat','readdir','mkdir'].includes(method))throw failure('ENOSYS','Unsupported compiler filesystem operation: '+method)
      if(['open','stat','lstat','readdir','mkdir'].includes(method)&&
        (typeof args[0]!=='string'||args[0].length>4096))throw failure('EINVAL','Invalid compiler filesystem path')
      if(method==='mkdir'&&(!Number.isSafeInteger(args[1])||(args[1] as number)<0||(args[1] as number)>0o7777))throw failure('EINVAL','Invalid compiler directory mode')
      // Only the documented arguments reach the lease, no arbitrary readdir options.
      const count=method==='open'||method==='read'||method==='write'?3:method==='mkdir'?2:1
      const result=this.#lease.call(method,args.slice(0,count))
      if(method==='readdir'&&new TextEncoder().encode(JSON.stringify(result)).length>65536)throw failure('EOVERFLOW','Directory reply exceeds compiler transport limit')
      return result
    }catch(error){throw ioError(error)}finally{this.#pending--}
  }
  close(){if(this.#closed)return;this.#closed=true;this.#lease.close()}
}

/** Worker-side callback adapter. The supplied call must be an owned RPC endpoint.
 * Stdin/stdout are deliberately separate, this adapter only handles workspace fds.
 */
export function createCompilerFilesystem(call:Call){
  const send=(method:string,args:unknown[],callback:Callback,map=(value:unknown)=>value)=>{
    Promise.resolve().then(()=>call(method,args)).then(map).then(value=>callback(null,value),error=>callback(ioError(error)))
  }
  const stat=(value:unknown)=>{
    const fields=value as WorkspaceStat
    return {...fields,isDirectory:()=>fields.kind==='directory',isFile:()=>fields.kind==='file',isSymbolicLink:()=>fields.kind==='symlink'}
  }
  const range=(buffer:Uint8Array,offset:number,length:number)=>{
    if(!(buffer instanceof Uint8Array)||!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<0||offset>buffer.length-length)throw failure('EINVAL','Invalid compiler filesystem buffer range')
  }
  return {
    constants:{O_WRONLY:1,O_RDWR:2,O_CREAT:64,O_TRUNC:512,O_APPEND:1024,O_EXCL:128,O_DIRECTORY:65536},
    open(path:string,flags:number,mode:number,callback:Callback){send('open',[path,flags,mode],callback)},
    close(fd:number,callback:Callback){send('close',[fd],callback)},
    stat(path:string,callback:Callback){send('stat',[path],callback,stat)},
    lstat(path:string,callback:Callback){send('lstat',[path],callback,stat)},
    fstat(fd:number,callback:Callback){send('fstat',[fd],callback,stat)},
    readdir(path:string,callback:Callback){send('readdir',[path],callback)},
    mkdir(path:string,mode:number,callback:Callback){send('mkdir',[path,mode],callback)},
    read(fd:number,buffer:Uint8Array,offset:number,length:number,position:number|null,callback:Callback){
      // File I/O permits short reads. Keep each RPC bounded even when Go
      // supplies a larger buffer, and let its ordinary read loop continue.
      Promise.resolve().then(()=>{range(buffer,offset,length);return call('read',[fd,Math.min(length,65536),position])}).then(value=>{
        if(!(value instanceof Uint8Array)||value.length>Math.min(length,65536))throw failure('EIO','Invalid filesystem read reply')
        buffer.set(value,offset);return value.length
      }).then(count=>callback(null,count,buffer),error=>callback(ioError(error)))
    },
    write(fd:number,buffer:Uint8Array,offset:number,length:number,position:number|null,callback:Callback){
      let bytes:Uint8Array
      try{range(buffer,offset,length);bytes=buffer.slice(offset,offset+Math.min(length,65536))}catch(error){queueMicrotask(()=>callback(ioError(error)));return}
      send('write',[fd,bytes,position],(error,count)=>callback(error,count,buffer))
    },
    ...Object.fromEntries(['chmod','chown','fchmod','fchown','fsync','ftruncate','lchown','link','readlink','rename','rmdir','symlink','truncate','unlink','utimes'].map(method=>[method,(...args:any[])=>{
      const callback=args.at(-1) as Callback
      queueMicrotask(()=>callback(failure('ENOSYS','Unsupported compiler filesystem operation: '+method)))
    }])),
    writeSync(){throw failure('ENOSYS','Synchronous workspace writes are unsupported')},
  }
}
