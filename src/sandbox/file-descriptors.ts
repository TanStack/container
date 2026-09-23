import {WorkspaceFiles,fileCreationMode,type WorkspaceFileReference} from './files'
// @ts-expect-error Shared guest/host virtual filesystem ABI.
import {O_WRONLY,O_RDWR,O_CREAT,O_EXCL,O_TRUNC,O_APPEND} from './guest-fs-constants.js'

interface Descriptor {
  owner:number
  file:WorkspaceFileReference
  readable:boolean
  writable:boolean
  append:boolean
  position:number
}

function fail(code:string,message:string):never {
  throw Object.assign(new Error(code+': '+message),{code})
}
function offset(value:number) {
  if(!Number.isSafeInteger(value)||value<0)fail('EINVAL','invalid file offset or length')
}

// The kernel supplies owner IDs. Guest code never chooses the owner of a call.
// IDs are not reused, including after process cleanup.
export class FileDescriptors {
  #entries=new Map<number,Descriptor>()
  #next=3
  constructor(readonly files:WorkspaceFiles,readonly maxDescriptors=256,readonly maxPerOwner=64) {
    for(const value of [maxDescriptors,maxPerOwner])
      if(!Number.isSafeInteger(value)||value<1)throw new Error('Invalid descriptor limits')
  }
  get size(){return this.#entries.size}
  #get(owner:number,fd:number) {
    const entry=this.#entries.get(fd)
    if(!Number.isSafeInteger(fd)||!entry||entry.owner!==owner)fail('EBADF','invalid file descriptor')
    return entry
  }
  open(owner:number,path:string,flag:string|number,writable:boolean,mode?:unknown) {
    if(!Number.isSafeInteger(owner)||owner<0)throw new Error('Invalid process owner')
    const strings:Record<string,number>={r:0,'r+':O_RDWR,w:O_WRONLY|O_CREAT|O_TRUNC,wx:O_WRONLY|O_CREAT|O_TRUNC|O_EXCL,'w+':O_RDWR|O_CREAT|O_TRUNC,'wx+':O_RDWR|O_CREAT|O_TRUNC|O_EXCL,a:O_WRONLY|O_CREAT|O_APPEND,ax:O_WRONLY|O_CREAT|O_APPEND|O_EXCL,'a+':O_RDWR|O_CREAT|O_APPEND,'ax+':O_RDWR|O_CREAT|O_APPEND|O_EXCL}
    const bits=typeof flag==='string'?strings[flag]:flag
    const mask=O_WRONLY|O_RDWR|O_CREAT|O_EXCL|O_TRUNC|O_APPEND
    if(!Number.isSafeInteger(bits)||bits<0||bits>mask||(bits&~mask)||(bits&3)===3)fail('ENOTSUP','unsupported file open flags: '+String(flag))
    const readable=(bits&3)!==O_WRONLY,write=(bits&3)!==0
    const create=!!(bits&O_CREAT),truncate=!!(bits&O_TRUNC),append=!!(bits&O_APPEND)
    fileCreationMode(mode)
    if((write||create||truncate)&&!writable)fail('EACCES','read-only process')
    if(this.#entries.size>=this.maxDescriptors)fail('ENFILE','workspace descriptor limit reached')
    if([...this.#entries.values()].filter(entry=>entry.owner===owner).length>=this.maxPerOwner)
      fail('EMFILE','process descriptor limit reached')
    if(this.#next>=Number.MAX_SAFE_INTEGER)fail('ENFILE','descriptor IDs exhausted')
    if(create&&(bits&O_EXCL)&&this.files.entryExistsSync(path))fail('EEXIST',path)
    const exists=this.files.existsSync(path)
    if(!exists&&!create)fail('ENOENT',path)
    if(!exists)this.files.writeFileSync(path,new Uint8Array(),false,true,mode)
    const directory=this.files.isDirectorySync(path)
    if(directory&&(write||create||truncate))fail('EISDIR',path)
    const file=directory?this.files.acquireDirectorySync(path):this.files.acquireFileSync(path)
    try {
      if(exists&&truncate)file.truncate(0)
      const fd=this.#next++
      this.#entries.set(fd,{owner,file,readable,writable:write,append,position:0})
      return fd
    }catch(error){file.close();throw error}
  }
  read(owner:number,fd:number,length:number,position:number|null=null) {
    const entry=this.#get(owner,fd)
    if(!entry.readable)fail('EBADF','descriptor is not readable')
    offset(length);if(position!==null)offset(position)
    const bytes=entry.file.read(position??entry.position,length)
    if(position===null)entry.position+=bytes.length
    return bytes
  }
  write(owner:number,fd:number,bytes:Uint8Array,position:number|null=null) {
    const entry=this.#get(owner,fd)
    if(!entry.writable)fail('EBADF','descriptor is not writable')
    if(position!==null)offset(position)
    // Explicit positions use positioned I/O, matching Node on this macOS
    // reference host. Linux pwrite with O_APPEND differs and is not emulated.
    const start=position??(entry.append?entry.file.stat().size:entry.position)
    const written=entry.file.write(start,bytes)
    if(position===null)entry.position=start+written
    return written
  }
  stat(owner:number,fd:number){return this.#get(owner,fd).file.stat()}
  truncate(owner:number,fd:number,length=0) {
    const entry=this.#get(owner,fd)
    if(!entry.writable)fail('EINVAL','descriptor is not writable')
    offset(length);entry.file.truncate(length)
  }
  close(owner:number,fd:number) {
    const entry=this.#get(owner,fd)
    this.#entries.delete(fd);entry.file.close()
  }
  closeOwner(owner:number) {
    for(const [fd,entry] of this.#entries)if(entry.owner===owner)this.close(owner,fd)
  }
}
