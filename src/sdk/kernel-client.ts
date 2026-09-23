import {HOST_PROTOCOL_VERSION,parseHostServerMessage,type HostCapabilities,type HostOperation,type HostOperationMap,type HostServerMessage} from './host-protocol'
import type {PortEvent} from '../sandbox/virtual-network'

type Pending={resolve:(value:any)=>void;reject:(error:Error)=>void;output?:(level:string,text:string)=>void;cleanup?:()=>void}

export interface KernelClientOptions {nonce:string;handshakeTimeoutMs?:number;expectedBuildId?:string}
export interface KernelRequestOptions {signal?:AbortSignal;onOutput?:(level:string,text:string)=>void;timeoutMs?:number}

/** Typed RPC transport used by HostedKernel. A client owns exactly one MessagePort. */
export class KernelClient {
  readonly ready:Promise<HostCapabilities>
  #port:MessagePort
  #nonce:string
  #expectedBuildId?:string
  #next=0
  #closed=false
  #attached=false
  #pending=new Map<number,Pending>()
  #ports=new Set<number>()
  #portListeners=new Set<(event:PortEvent)=>void>()
  #readyResolve!:(value:HostCapabilities)=>void
  #readyReject!:(error:Error)=>void
  #timer:ReturnType<typeof setTimeout>
  constructor(port:MessagePort,options:KernelClientOptions){
    this.#port=port;this.#nonce=options.nonce;this.#expectedBuildId=options.expectedBuildId
    this.ready=new Promise((resolve,reject)=>{this.#readyResolve=resolve;this.#readyReject=reject})
    const timeout=options.handshakeTimeoutMs??10_000
    this.#timer=setTimeout(()=>this.disconnect(new Error(`Browser sandbox host handshake timed out (${timeout}ms)`)),timeout)
    port.onmessage=event=>this.#receive(event.data)
    port.onmessageerror=()=>this.disconnect(new Error('Browser sandbox host sent an unreadable message'))
    port.start()
  }
  get closed(){return this.#closed}
  get listeningPorts(){return [...this.#ports].sort((a,b)=>a-b)}
  subscribePorts(callback:(event:PortEvent)=>void){
    if(this.#closed)throw Error('Kernel client closed')
    this.#portListeners.add(callback)
    for(const port of this.listeningPorts)callback(Object.freeze({type:'open',port}))
    return ()=>this.#portListeners.delete(callback)
  }
  #receive(value:unknown){
    let message:HostServerMessage
    try{message=parseHostServerMessage(value)}catch(error){this.disconnect(error instanceof Error?error:Error(String(error)));return}
    if(message.type==='attached'){
      if(this.#attached||message.nonce!==this.#nonce||message.protocolVersion!==HOST_PROTOCOL_VERSION){this.disconnect(Error('Browser sandbox host handshake did not match this client'));return}
      if(this.#expectedBuildId!==undefined&&message.capabilities.buildId!==this.#expectedBuildId){this.disconnect(Error(`Browser sandbox host build mismatch: expected ${this.#expectedBuildId}, received ${message.capabilities.buildId}`));return}
      this.#attached=true;clearTimeout(this.#timer);this.#readyResolve(Object.freeze({...message.capabilities,operations:Object.freeze([...message.capabilities.operations])}));return
    }
    if(!this.#attached){this.disconnect(Error('Browser sandbox host replied before attachment'));return}
    if(message.type==='port'){
      if(message.event.type==='open')this.#ports.add(message.event.port);else this.#ports.delete(message.event.port)
      for(const listener of [...this.#portListeners])try{listener(Object.freeze({...message.event}))}catch{}
      return
    }
    if(message.type==='closed'){const reason=message.reason?remoteError(message.reason):Error('Browser sandbox host closed');this.disconnect(reason);return}
    if(message.type==='output'){
      const pending=this.#pending.get(message.requestId)
      try{pending?.output?.(message.level,message.text)}catch(error){this.disconnect(Error('Output observer failed: '+String(error)))}
      return
    }
    const pending=this.#pending.get(message.id)
    if(!pending)return
    this.#pending.delete(message.id);pending.cleanup?.()
    message.type==='error'?pending.reject(remoteError(message.error)):pending.resolve(message.value)
  }
  async request<K extends HostOperation>(operation:K,args:HostOperationMap[K]['args'],options:KernelRequestOptions={}):Promise<HostOperationMap[K]['result']>{
    options.signal?.throwIfAborted();await this.ready;options.signal?.throwIfAborted()
    if(this.#closed)throw Error('Kernel client closed')
    const id=++this.#next
    return new Promise((resolve,reject)=>{
      let timer:ReturnType<typeof setTimeout>|undefined
      const finish=(error:Error)=>{if(!this.#pending.delete(id))return;cleanup();this.#port.postMessage({type:'cancel',requestId:id});reject(error)}
      const abort=options.signal?()=>finish(options.signal!.reason instanceof Error?options.signal!.reason:new DOMException('Aborted','AbortError')):undefined
      const cleanup=()=>{if(timer)clearTimeout(timer);if(abort)options.signal!.removeEventListener('abort',abort)}
      if(options.timeoutMs!==undefined){
        if(!Number.isFinite(options.timeoutMs)||options.timeoutMs<=0)throw new RangeError('Kernel request timeout must be positive')
        timer=setTimeout(()=>finish(Error(`Browser sandbox host request timed out: ${operation} (${options.timeoutMs}ms)`)),options.timeoutMs)
      }
      this.#pending.set(id,{resolve,reject,output:options.onOutput,cleanup})
      options.signal?.addEventListener('abort',abort!,{once:true})
      try{this.#port.postMessage({type:'request',id,operation,args})}catch(error){this.#pending.delete(id);cleanup?.();reject(error)}
    })
  }
  disconnect(error=Error('Kernel client disconnected')){
    if(this.#closed)return
    this.#closed=true;clearTimeout(this.#timer)
    if(!this.#attached)this.#readyReject(error)
    for(const pending of this.#pending.values()){pending.cleanup?.();pending.reject(error)}
    this.#pending.clear()
    const ports=this.listeningPorts;this.#ports.clear()
    for(const port of ports)for(const listener of [...this.#portListeners])try{listener(Object.freeze({type:'close',port}))}catch{}
    this.#portListeners.clear();this.#port.onmessage=null;this.#port.onmessageerror=null;this.#port.close()
  }
}

function remoteError(value:{name:string;message:string;code?:string}){
  const error=Error(value.message);error.name=value.name
  if(value.code!==undefined)Object.assign(error,{code:value.code})
  return error
}
