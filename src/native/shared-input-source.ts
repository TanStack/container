type Chunk={bytes:Uint8Array;resolve:()=>void;reject:(error:Error)=>void}
type Reader={owner:object;resolve:(bytes:Uint8Array|null)=>void;reject:(error:Error)=>void;cleanup:()=>void}
const closedError=()=>Object.assign(Error('Input source is closed'),{code:'EPIPE'})
export let processInputSource:NativeSharedInputSource|undefined
export function setProcessInputSource(source:NativeSharedInputSource|undefined){processInputSource=source}

/** One consumable byte source, shared by process descriptors rather than broadcast. */
export class NativeSharedInputSource{
  #chunks:Chunk[]=[]
  #readers:Reader[]=[]
  #bytes=0
  #ended=false
  #closed:Error|undefined
  #demandPending=false
  constructor(private onDemand?:()=>void){}
  write(bytes:Uint8Array|null):Promise<void>{
    if(this.#closed||this.#ended)throw this.#closed??closedError()
    if(bytes===null){this.#demandPending=false;this.#ended=true;this.#drain();return Promise.resolve()}
    if(!(bytes instanceof Uint8Array)||bytes.byteLength>65536)throw new TypeError('Invalid input chunk')
    if(this.#bytes+bytes.byteLength>1024*1024||this.#chunks.length>=1024)throw Error('Input source queue is full')
    if(!bytes.byteLength)return Promise.resolve()
    const receipt=new Promise<void>((resolve,reject)=>this.#chunks.push({bytes:bytes.slice(),resolve,reject}))
    this.#bytes+=bytes.byteLength
    this.#demandPending=false
    this.#drain()
    return receipt
  }
  read(owner:object,signal?:AbortSignal):Promise<Uint8Array|null>{
    if(this.#closed)return Promise.reject(this.#closed)
    if(signal?.aborted)return Promise.reject(signal.reason)
    if(this.#readers.some(reader=>reader.owner===owner))return Promise.reject(Error('Input read is already pending'))
    return new Promise((resolve,reject)=>{
      const reader:Reader={owner,resolve,reject,cleanup:()=>signal?.removeEventListener('abort',abort)}
      const abort=()=>{
        const index=this.#readers.indexOf(reader)
        if(index<0)return
        this.#readers.splice(index,1);reader.cleanup();reject(signal?.reason)
      }
      this.#readers.push(reader)
      signal?.addEventListener('abort',abort,{once:true})
      this.#drain()
    })
  }
  cancelReader(owner:object,error=closedError()){
    for(const reader of [...this.#readers])if(reader.owner===owner){
      this.#readers.splice(this.#readers.indexOf(reader),1);reader.cleanup();reader.reject(error)
    }
  }
  close(error=closedError()){
    if(this.#closed)return
    this.#closed=error
    for(const chunk of this.#chunks.splice(0))chunk.reject(error)
    for(const reader of this.#readers.splice(0)){reader.cleanup();reader.reject(error)}
    this.#bytes=0
  }
  #drain(){
    while(this.#readers.length&&(this.#chunks.length||this.#ended)){
      const reader=this.#readers.shift()!;reader.cleanup()
      const chunk=this.#chunks.shift()
      if(!chunk){reader.resolve(null);continue}
      this.#bytes-=chunk.bytes.byteLength
      reader.resolve(chunk.bytes);chunk.resolve()
    }
    if(this.onDemand&&this.#readers.length&&!this.#ended&&!this.#closed&&!this.#demandPending){
      this.#demandPending=true;this.onDemand()
    }
  }
}
