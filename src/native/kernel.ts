import NativeWorker from './kernel.worker?worker'

export interface NativeResponse {status:number;headers:[string,string][];body:string}
export interface NativeRequest {url:string;method?:string;headers?:HeadersInit;body?:string}
import type {RuntimeLock} from '../npm/types'
type Pending={resolve:(value:any)=>void;reject:(reason:Error)=>void;timer:ReturnType<typeof setTimeout>}

/** Browser-native execution backend. Each instance owns one disposable worker. */
export class NativeKernel {
  #worker:Worker
  #pending=new Map<number,Pending>()
  #next=0
  #closed=false
  constructor(){
    this.#worker=new NativeWorker()
    this.#worker.onmessage=({data})=>{
      const pending=this.#pending.get(data.id)
      if(!pending)return
      this.#pending.delete(data.id)
      clearTimeout(pending.timer)
      data.ok?pending.resolve(data.value):pending.reject(new Error(data.error))
    }
    this.#worker.onerror=event=>this.close(new Error(event.message))
  }
  #call<T>(operation:string,fields:Record<string,unknown>={},timeoutMs=30000):Promise<T>{
    if(this.#closed)return Promise.reject(new Error('Native kernel closed'))
    return new Promise((resolve,reject)=>{
      const id=++this.#next
      const timer=setTimeout(()=>this.close(new Error(`Native kernel ${operation} timed out`)),timeoutMs)
      this.#pending.set(id,{resolve,reject,timer})
      this.#worker.postMessage({id,operation,...fields})
    })
  }
  initialize(files:Record<string,string|Uint8Array>={}){return this.#call<void>('initialize',{files})}
  installLocked(lock:RuntimeLock){return this.#call<{packages:number}>('install',{lock},90000)}
  load(code:string,files?:Record<string,string|Uint8Array>,options:{asyncContext?:boolean}={}){
    return this.#call<{loaded:true}>('load',{code,files,...options})
  }
  loadEntry(entry:string,options:{asyncContext?:boolean}={}){
    return this.#call<{loaded:true}>('loadEntry',{entry,...options},90000)
  }
  request(request:NativeRequest){
    return this.#call<NativeResponse>('request',{...request})
  }
  readFile(path:string){return this.#call<Uint8Array>('readFile',{path})}
  writeFile(path:string,bytes:Uint8Array){return this.#call<void>('writeFile',{path,bytes})}
  snapshot(){return this.#call<Record<string,Uint8Array>>('snapshot')}
  close(reason=new Error('Native kernel closed')){
    if(this.#closed)return
    this.#closed=true
    this.#worker.terminate()
    for(const pending of this.#pending.values()){
      clearTimeout(pending.timer)
      pending.reject(reason)
    }
    this.#pending.clear()
  }
}
