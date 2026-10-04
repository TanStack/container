import type {VirtualNetwork} from '../sandbox/virtual-network'

/** A child worker allocates public virtual listener ports through its parent. */
export function createNativeSyncPortLane(){
  if(typeof SharedArrayBuffer!=='function')throw Error('Synchronous port allocation requires SharedArrayBuffer')
  return new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT*2)
}

export class NativeSyncPortHost {
  #header:Int32Array
  #reserved=new Set<number>()
  #closed=false
  constructor(private network:VirtualNetwork,private port:MessagePort,lane:SharedArrayBuffer){
    if(!(lane instanceof SharedArrayBuffer)||lane.byteLength!==Int32Array.BYTES_PER_ELEMENT*2)
      throw Error('Invalid shared port lane')
    this.#header=new Int32Array(lane)
    port.onmessage=({data})=>{
      if(this.#closed)return
      let status=1,value=0
      try{
        if(data?.type!=='allocate')throw Error('Invalid port allocation request')
        value=this.network.reserveListenerPort(data.requested)
        this.#reserved.add(value)
      }catch(error){status=(error as {code?:string})?.code==='EADDRINUSE'?-2:-1}
      Atomics.store(this.#header,1,value)
      Atomics.store(this.#header,0,status)
      Atomics.notify(this.#header,0)
    }
    port.onmessageerror=()=>this.close()
    port.start()
  }
  owns(port:number){return this.#reserved.has(port)}
  claim(port:number){
    if(!this.#reserved.delete(port))throw Error('Child port reservation is unavailable')
  }
  release(port:number){
    if(!this.#reserved.delete(port))return
    this.network.releaseReservedPort(port)
  }
  close(){
    if(this.#closed)return
    this.#closed=true
    this.port.close()
    for(const port of this.#reserved)this.network.releaseReservedPort(port)
    this.#reserved.clear()
  }
}

/** Only call from a dedicated worker, never the browser main thread. */
export class NativeSyncPortClient {
  #header:Int32Array
  #closed=false
  constructor(private port:MessagePort,lane:SharedArrayBuffer){
    if(!(lane instanceof SharedArrayBuffer)||lane.byteLength!==Int32Array.BYTES_PER_ELEMENT*2)
      throw Error('Invalid shared port lane')
    this.#header=new Int32Array(lane)
  }
  allocate(requested=0){
    if(this.#closed)throw Error('Synchronous port allocator is closed')
    Atomics.store(this.#header,0,0)
    this.port.postMessage({type:'allocate',requested})
    const deadline=performance.now()+30000
    while(Atomics.load(this.#header,0)===0){
      const remaining=deadline-performance.now()
      if(remaining<=0){this.close();throw Error('Synchronous port allocation timed out')}
      const wait=Atomics.wait(this.#header,0,0,remaining)
      if(wait==='timed-out'&&Atomics.load(this.#header,0)===0){
        this.close();throw Error('Synchronous port allocation timed out')
      }
    }
    const status=Atomics.load(this.#header,0),port=Atomics.load(this.#header,1)
    if(status===-2)throw Object.assign(Error('EADDRINUSE'),{code:'EADDRINUSE'})
    if(status!==1||port<1||port>65535)throw Error('Virtual port allocation failed')
    return port
  }
  close(){if(this.#closed)return;this.#closed=true;this.port.close()}
}
