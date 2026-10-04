/** One process owns writes, its worker threads read the same directory state. */
export class SharedWorkingDirectory{
  readonly buffer:SharedArrayBuffer
  #header:Int32Array
  #bytes:Uint8Array
  constructor(buffer:SharedArrayBuffer=new SharedArrayBuffer(8204)){
    if(buffer.byteLength!==8204)throw Error('Invalid shared working directory buffer')
    this.buffer=buffer
    this.#header=new Int32Array(buffer,0,3)
    this.#bytes=new Uint8Array(buffer,12)
  }
  write(directory:string){
    const bytes=new TextEncoder().encode(directory)
    if(bytes.length>=4096)throw Object.assign(Error('Working directory path is too long'),{code:'ENAMETOOLONG'})
    const version=Atomics.load(this.#header,0),slot=(version+1)&1
    // Fill the unpublished slot, readers can keep using the completed value
    // even if this process is terminated before the final atomic publication.
    this.#bytes.set(bytes,slot*4096)
    Atomics.store(this.#header,slot+1,bytes.length)
    Atomics.store(this.#header,0,version+1)
  }
  read(){
    for(;;){
      const version=Atomics.load(this.#header,0)
      const slot=version&1,length=Atomics.load(this.#header,slot+1)
      if(length<0||length>=4096)throw Error('Invalid shared working directory length')
      const bytes=this.#bytes.slice(slot*4096,slot*4096+length)
      if(Atomics.load(this.#header,0)===version)return new TextDecoder().decode(bytes)
    }
  }
}

let processDirectory:SharedWorkingDirectory|undefined
export function getProcessDirectory(initial='/app'){
  if(!processDirectory){processDirectory=new SharedWorkingDirectory();processDirectory.write(initial)}
  return processDirectory
}
export function initializeProcessDirectory(directory:string,buffer?:SharedArrayBuffer){
  processDirectory=new SharedWorkingDirectory(buffer)
  if(!buffer)processDirectory.write(directory)
  return processDirectory
}
