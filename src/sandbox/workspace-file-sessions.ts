import {FileDescriptors} from './file-descriptors'
import {fileCallSync} from './file-capability'
import {validateWorkspacePath,type WorkspaceFiles} from './files'

function fail(code:string,message:string):never{throw Object.assign(Error(code+': '+message),{code})}
function position(value:unknown){
  if(value===null||value===undefined)return null
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)fail('EINVAL','invalid file position')
  return value
}

// The kernel owns these leases. A worker receives only its own call endpoint,
// never an API that accepts another session's owner ID.
export class WorkspaceFileSessions {
  #descriptors:FileDescriptors
  #sessions=new Map<number,()=>void>()
  #next=0
  #closed=false
  constructor(private files:WorkspaceFiles){this.#descriptors=new FileDescriptors(files,256,64)}
  get size(){return this.#sessions.size}
  get descriptors(){return this.#descriptors.size}
  open(writable:boolean){
    if(this.#closed)fail('EBADF','file sessions closed')
    if(typeof writable!=='boolean')throw new TypeError('Expected write authority')
    if(this.size>=8||this.#next>=Number.MAX_SAFE_INTEGER)fail('EMFILE','file session limit reached')
    const owner=++this.#next
    let closed=false
    const close=()=>{
      if(closed)return
      closed=true;this.#descriptors.closeOwner(owner);this.#sessions.delete(owner)
    }
    const call=(method:string,args:unknown[]):unknown=>{
      if(closed||this.#closed)fail('EBADF','file session closed')
      if(!Array.isArray(args))throw new TypeError('Expected file arguments')
      if(method==='open'){
        if(typeof args[0]!=='string'||!['string','number'].includes(typeof args[1]))throw new TypeError('Invalid open arguments')
        validateWorkspacePath(args[0])
        return this.#descriptors.open(owner,args[0],args[1] as string|number,writable,args[2])
      }
      if(method==='stat'||method==='lstat'||method==='readdir')return fileCallSync(this.files,writable,method,args)
      if(['mkdir','rm','rename'].includes(method)){
        if(!writable)fail('EACCES','file session is read only')
        return fileCallSync(this.files,writable,method,args)
      }
      const fd=args[0]
      if(typeof fd!=='number'||!Number.isSafeInteger(fd))fail('EBADF','invalid descriptor')
      if(method==='close')return this.#descriptors.close(owner,fd)
      if(method==='fstat')return this.#descriptors.stat(owner,fd)
      if(method==='read'){
        const length=args[1]
        if(typeof length!=='number'||!Number.isSafeInteger(length)||length<0||length>65536)fail('EINVAL','read exceeds transport limit')
        return this.#descriptors.read(owner,fd,length,position(args[2]))
      }
      if(method==='write'){
        const bytes=args[1]
        if(!(bytes instanceof Uint8Array)||bytes.byteLength>65536)fail('EINVAL','write exceeds transport limit')
        return this.#descriptors.write(owner,fd,bytes,position(args[2]))
      }
      fail('ENOTSUP','unsupported file operation')
    }
    this.#sessions.set(owner,close)
    return {call,close}
  }
  close(){
    if(this.#closed)return
    this.#closed=true
    for(const close of this.#sessions.values())close()
  }
}
