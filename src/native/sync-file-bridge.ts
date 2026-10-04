import type {NativeFileOperations} from './filesystem-operations'
import {NativeTerminalFileSession} from './terminal-file-session'

const capacity=65536
const headerBytes=Int32Array.BYTES_PER_ELEMENT*4
const encoder=new TextEncoder(),decoder=new TextDecoder()
type Request={method:string;args:unknown[]}

/** One fixed-size shared reply lane, owned by a single command worker. */
export function createNativeSyncFileLane(){
  if(typeof SharedArrayBuffer!=='function')throw Error('Synchronous file bridge requires SharedArrayBuffer')
  return new SharedArrayBuffer(headerBytes+capacity)
}

export class NativeSyncFileHost {
  readonly files:NativeTerminalFileSession
  #closed=false
  #header:Int32Array
  #body:Uint8Array
  constructor(volume:NativeFileOperations,private port:MessagePort,lane:SharedArrayBuffer,private upstream?:NativeSyncFileClient){
    if(!(lane instanceof SharedArrayBuffer)||lane.byteLength!==headerBytes+capacity)throw Error('Invalid shared file lane')
    this.files=new NativeTerminalFileSession(volume)
    this.#header=new Int32Array(lane,0,4)
    this.#body=new Uint8Array(lane,headerBytes)
    port.onmessage=({data}:MessageEvent<Request>)=>{
      if(this.#closed)return
      try{
        if(!data||typeof data.method!=='string'||!Array.isArray(data.args))throw Error('Invalid file request')
        const value=this.upstream?this.upstream.call(data.method,data.args):this.files.call(data.method,data.args)
        this.#reply(1,value instanceof Uint8Array?1:2,value instanceof Uint8Array?value:encoder.encode(JSON.stringify({value})))
      }catch(error){
        const code=error&&typeof error==='object'&&'code' in error?String(error.code):undefined
        this.#reply(-1,2,encoder.encode(JSON.stringify({message:String(error).slice(0,1024),code})))
      }
    }
    port.onmessageerror=()=>this.close()
    port.start()
  }
  #reply(status:number,kind:number,bytes:Uint8Array){
    if(bytes.byteLength>capacity){
      status=-1;kind=2;bytes=encoder.encode(JSON.stringify({message:'Synchronous file response exceeds 64 KB'}))
    }
    this.#body.set(bytes)
    Atomics.store(this.#header,1,bytes.byteLength)
    Atomics.store(this.#header,2,kind)
    Atomics.store(this.#header,0,status)
    Atomics.notify(this.#header,0)
  }
  close(){
    if(this.#closed)return
    this.#closed=true
    this.port.close();this.files.close()
  }
}

/** Child-worker side. Never use this on the browser main thread. */
export class NativeSyncFileClient {
  #header:Int32Array
  #body:Uint8Array
  #closed=false
  constructor(private port:MessagePort,lane:SharedArrayBuffer){
    if(!(lane instanceof SharedArrayBuffer)||lane.byteLength!==headerBytes+capacity)throw Error('Invalid shared file lane')
    this.#header=new Int32Array(lane,0,4)
    this.#body=new Uint8Array(lane,headerBytes)
  }
  call(method:string,args:unknown[]):unknown{
    if(this.#closed)throw Error('Synchronous file bridge is closed')
    if(typeof method!=='string'||!Array.isArray(args))throw Error('Invalid file request')
    Atomics.store(this.#header,0,0)
    this.port.postMessage({method,args} satisfies Request)
    const deadline=performance.now()+30000
    let wait:'ok'|'not-equal'|'timed-out'='not-equal'
    // A host can publish a reply before notifying. The client may consume it
    // and start its next call before that previous notification arrives.
    // A wakeup is not a reply, always recheck the shared predicate.
    while(Atomics.load(this.#header,0)===0){
      const remaining=deadline-performance.now()
      if(remaining<=0){this.close();throw Error('Synchronous file request timed out')}
      wait=Atomics.wait(this.#header,0,0,remaining)
      if(wait==='timed-out'&&Atomics.load(this.#header,0)===0){
        this.close();throw Error('Synchronous file request timed out')
      }
    }
    const status=Atomics.load(this.#header,0),length=Atomics.load(this.#header,1),kind=Atomics.load(this.#header,2)
    if(![-1,1].includes(status)||length<0||length>capacity||![1,2].includes(kind)){
      this.close();throw Error(`Invalid synchronous file response (${wait}, status ${status}, length ${length}, kind ${kind})`)
    }
    const bytes=this.#body.slice(0,length)
    if(status===-1){
      const detail=JSON.parse(decoder.decode(bytes)) as {message:string;code?:string}
      throw Object.assign(Error(detail.message),detail.code?{code:detail.code}:{})
    }
    return kind===1?bytes:(JSON.parse(decoder.decode(bytes)) as {value:unknown}).value
  }
  close(){if(this.#closed)return;this.#closed=true;this.port.close()}
}
