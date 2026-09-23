export interface CallableOptions {
  createWorker():Worker
  snapshot:unknown
  descriptor:unknown
  callbacks:string[]
  wasmSHA256:string
  callback(method:string,args:unknown[]):Promise<unknown>
}
type CallableCommand={command:'resolve';id:string;importer:string;options:unknown}|{command:'update';path:string;source:string;event:'update'}|{command:'close'}
/** Test-only transport. Guest functions stay in the separate SDK guest process. */
export class CallableSession {
  #worker:Worker
  #closed=false
  #sequence=0
  #pending=new Map<number,{resolve(value:any):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}>()
  #callbacks=new Set<SharedArrayBuffer>()
  #ready:Promise<void>
  #closing:Promise<any>|undefined
  #abortTimer:ReturnType<typeof setTimeout>|undefined
  cleanup:unknown
  hooks:unknown
  private constructor(private options:CallableOptions){
    if(!crossOriginIsolated||typeof SharedArrayBuffer==='undefined')throw Error('Callable resolver requires COI and SAB')
    this.#worker=options.createWorker()
    this.#ready=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{const error=Error('Callable resolver startup deadline');reject(error);this.#stop(error)},30000)
      this.#worker.onerror=event=>{clearTimeout(timer);const error=Error(event.message);reject(error);this.#stop(error)}
      this.#worker.onmessage=({data})=>{
        if(data.type==='closed'){clearTimeout(this.#abortTimer);this.cleanup=data;this.#worker.terminate();return}
        if(this.#closed)return
        if(data.type==='ready'){clearTimeout(timer);this.hooks=data.hooks;resolve();return}
        if(data.type==='error'){clearTimeout(timer);const error=Error(data.error);reject(error);this.#stop(error);return}
        if(data.type==='callback'){
          if(this.#callbacks.size) {this.#reply(data.buffer,undefined,Error('Overlapping synchronous callback'));return}
          this.#callbacks.add(data.buffer)
          void Promise.resolve().then(()=>options.callback(data.method,data.args)).then(value=>this.#reply(data.buffer,value),error=>this.#reply(data.buffer,undefined,error)).finally(()=>this.#callbacks.delete(data.buffer))
          return
        }
        if(data.type==='result'){
          const pending=this.#pending.get(data.request)
          if(!pending)return
          clearTimeout(pending.timer);this.#pending.delete(data.request)
          data.error?pending.reject(Error(data.error)):pending.resolve(data.value)
          return
        }
        this.#stop(Error('Unsupported callable resolver reply'))
      }
      try{this.#worker.postMessage({type:'start',snapshot:options.snapshot,descriptor:options.descriptor,callbacks:options.callbacks,wasmSHA256:options.wasmSHA256})}catch(error){clearTimeout(timer);const failure=Error(String(error));reject(failure);this.#stop(failure)}
    })
  }
  static async open(options:CallableOptions){const session=new CallableSession(options);await session.#ready;return session}
  #reply(buffer:SharedArrayBuffer,value?:unknown,error?:unknown){
    const header=new Int32Array(buffer,0,4)
    if(Atomics.load(header,0)!==0)return
    let reply=error?{error:String(error)}:value===undefined?{kind:'undefined'}:value===null?{kind:'null'}:typeof value==='string'?{kind:'string',value}:{error:'Unsupported synchronous callback return'}
    let bytes=new TextEncoder().encode(JSON.stringify(reply))
    if(bytes.length>65536){reply={error:'Callback reply byte ceiling'};bytes=new TextEncoder().encode(JSON.stringify(reply))}
    new Uint8Array(buffer,16,bytes.length).set(bytes)
    Atomics.store(header,1,bytes.length);Atomics.store(header,0,'error' in reply?2:1);Atomics.notify(header,0)
  }
  #stop(error:Error){
    if(this.#closed)return
    this.#closed=true
    for(const buffer of this.#callbacks)this.#reply(buffer,undefined,error)
    this.#callbacks.clear()
    // Release callback waits, then wait for explicit owned pthread cleanup.
    this.#abortTimer=setTimeout(()=>{this.cleanup={error:'Callable resolver cleanup acknowledgement deadline'};this.#worker.terminate()},30000)
    for(const pending of this.#pending.values()){clearTimeout(pending.timer);pending.reject(error)}
    this.#pending.clear()
    try{this.#worker.postMessage({type:'abort'})}catch(failure){clearTimeout(this.#abortTimer);this.cleanup={error:String(failure)};this.#worker.terminate()}
  }
  #request(command:CallableCommand):Promise<any>{
    if(this.#closed||this.#closing)return Promise.reject(Error('Callable resolver session is closed'))
    return new Promise((resolve,reject)=>{
      const request=++this.#sequence
      const timer=setTimeout(()=>this.#stop(Error('Callable resolver request deadline')),30000)
      this.#pending.set(request,{resolve,reject,timer})
      try{this.#worker.postMessage({type:'command',request,...command})}catch(error){this.#stop(Error(String(error)))}
    })
  }
  resolve(id:string,importer:string,options:unknown){return this.#request({command:'resolve',id,importer,options})}
  update(path:string,source:string,event:'update'){return this.#request({command:'update',path,source,event})}
  close(){return this.#closing??=this.#request({command:'close'}).then(resources=>{this.#closed=true;this.#worker.terminate();return resources})}
}
