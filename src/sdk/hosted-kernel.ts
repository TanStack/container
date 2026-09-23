import type {WorkspaceSnapshot} from '../sandbox/files'
import type {CheckpointMetadata} from '../sandbox/checkpoint-storage'
import type {KernelExecutionResult,KernelOptions,KernelProcessResult,KernelResourceSnapshot} from '../sandbox/kernel'
import type {KernelOwnerOptions} from '../sandbox/kernel-limits'
import type {ProjectInstallOptions,ProjectInstallResult} from '../npm/project'
import type {ProcessEvent,SpawnOptions} from '../sandbox/guest-processes'
import type {NetworkEvent,PortEvent} from '../sandbox/virtual-network'
import {HOST_ATTACH_TYPE,HOST_PROTOCOL_VERSION,type HostAttachMessage,type HostCapabilities} from './host-protocol'
import {KernelClient} from './kernel-client'

export interface HostedKernelOptions {
  hostURL:string|URL
  kernel?:KernelOwnerOptions
  handshakeTimeoutMs?:number
  expectedBuildId?:string
  document?:Document
  /** Mount the host frame here before it loads. Required for hosted previews. */
  container?:HTMLElement
}
export interface HostedPreviewOptions {origin:string;port:number;path?:string;requestTimeoutMs?:number;startupTimeoutMs?:number}

/** A WorkerKernel-compatible owner client whose runtime lives in an isolated host frame. */
export class HostedKernel {
  readonly capabilities:HostCapabilities
  readonly hostURL:string
  readonly shutdown:Promise<void>|undefined=undefined
  #client:KernelClient
  #frame:HTMLIFrameElement
  #closed=false
  #shutdownResolve!:(value:void)=>void
  #shutdownReject!:(reason:unknown)=>void
  private constructor(client:KernelClient,frame:HTMLIFrameElement,capabilities:HostCapabilities,hostURL:string){
    this.#client=client;this.#frame=frame;this.capabilities=capabilities;this.hostURL=hostURL
    this.shutdown=new Promise((resolve,reject)=>{this.#shutdownResolve=resolve;this.#shutdownReject=reject})
  }
  static async create(files:Record<string,string|Uint8Array>={},options:HostedKernelOptions):Promise<HostedKernel>{
    const document=options.document??globalThis.document
    if(!document)throw Error('HostedKernel requires a document')
    const ownerOrigin=document.location.origin
    if(ownerOrigin==='null')throw Error('HostedKernel requires a non-opaque owner origin')
    const url=new URL(options.hostURL,document.baseURI)
    const loopback=url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)
    if(url.protocol!=='https:'&&!loopback)throw Error('HostedKernel hostURL must use HTTPS or loopback HTTP')
    if(url.origin===ownerOrigin)throw Error('HostedKernel requires a dedicated cross-origin host')
    if(url.username||url.password||url.hash)throw Error('HostedKernel hostURL cannot contain credentials or a fragment')
    const nonce=randomNonce()
    url.searchParams.set('ownerOrigin',ownerOrigin);url.searchParams.set('nonce',nonce)
    const frame=document.createElement('iframe')
    frame.tabIndex=-1;frame.setAttribute('sandbox','allow-scripts allow-same-origin');frame.setAttribute('allow','cross-origin-isolated');frame.referrerPolicy='no-referrer'
    if(options.container)Object.assign(frame.style,{position:'static',width:'100%',height:'100%',border:'0',pointerEvents:'auto',opacity:'1'})
    else{
      // Do not use the hidden attribute or display:none. The iframe owns the
      // compiler and process workers, and browsers throttle hidden frame trees.
      frame.setAttribute('aria-hidden','true')
      Object.assign(frame.style,{position:'fixed',left:'-10000px',top:'0',width:'1px',height:'1px',border:'0',pointerEvents:'none',opacity:'0.001'})
    }
    frame.src=url.href
    const loaded=new Promise<void>((resolve,reject)=>{frame.addEventListener('load',()=>resolve(),{once:true});frame.addEventListener('error',()=>reject(Error('Browser sandbox host failed to load')),{once:true})})
    ;(options.container??document.body??document.documentElement).append(frame)
    let client:KernelClient|undefined
    try{
      await withTimeout(loaded,options.handshakeTimeoutMs??10_000,'Browser sandbox host load timed out')
      if(!frame.contentWindow)throw Error('Browser sandbox host window is unavailable')
      const channel=new MessageChannel()
      client=new KernelClient(channel.port1,{nonce,handshakeTimeoutMs:options.handshakeTimeoutMs,expectedBuildId:options.expectedBuildId})
      const attach:HostAttachMessage={type:HOST_ATTACH_TYPE,protocolVersion:HOST_PROTOCOL_VERSION,nonce,ownerOrigin}
      frame.contentWindow.postMessage(attach,url.origin,[channel.port2])
      const capabilities=await client.ready
      if((options.kernel?.experimentalFibers||options.kernel?.experimentalRolldownParser)&&(!capabilities.crossOriginIsolated||!capabilities.sharedArrayBuffer))throw Error('Browser sandbox host is not cross-origin isolated')
      await client.request('kernel.create',[files,options.kernel??{}])
      return new HostedKernel(client,frame,capabilities,url.href)
    }catch(error){client?.disconnect(error instanceof Error?error:Error(String(error)));frame.remove();throw error}
  }
  get listeningPorts(){return this.#client.listeningPorts}
  subscribePorts(callback:(event:PortEvent)=>void){return this.#client.subscribePorts(callback)}
  async snapshot():Promise<WorkspaceSnapshot>{return this.#client.request('kernel.snapshot',[])}
  async restore(snapshot:WorkspaceSnapshot){await this.#client.request('kernel.restore',[snapshot])}
  async readFile(path:string):Promise<Uint8Array>{return this.#client.request('kernel.readFile',[path]) as Promise<Uint8Array>}
  async readText(path:string):Promise<string>{return this.#client.request('kernel.readFile',[path,'utf8']) as Promise<string>}
  async writeFile(path:string,data:Uint8Array){await this.#client.request('kernel.writeFile',[path,data])}
  async writeText(path:string,text:string){await this.writeFile(path,new TextEncoder().encode(text))}
  async install(options:ProjectInstallOptions={},signal?:AbortSignal):Promise<ProjectInstallResult>{return this.#client.request('kernel.install',[options],{signal})}
  async cancelInstall(){/* Install requests are cancelled through their AbortSignal. */}
  async resources():Promise<KernelResourceSnapshot>{return this.#client.request('kernel.resources',[])}
  async saveCheckpoint(key:string):Promise<CheckpointMetadata>{return this.#client.request('kernel.saveCheckpoint',[key])}
  async restoreCheckpoint(key:string):Promise<CheckpointMetadata>{return this.#client.request('kernel.restoreCheckpoint',[key])}
  async checkpointMetadata(key:string):Promise<CheckpointMetadata|undefined>{return this.#client.request('kernel.checkpointMetadata',[key])}
  async deleteCheckpoint(key:string):Promise<boolean>{return this.#client.request('kernel.deleteCheckpoint',[key])}
  async execute(code:string,{onOutput,...options}:KernelOptions={}):Promise<KernelExecutionResult>{return this.#client.request('kernel.execute',[code,options],{onOutput})}
  async run(entry:string,{onOutput,...options}:KernelOptions={}):Promise<KernelExecutionResult>{return this.#client.request('kernel.run',[entry,options],{onOutput})}
  async runModule(entry:string,{onOutput,...options}:KernelOptions={}):Promise<KernelExecutionResult>{return this.#client.request('kernel.runModule',[entry,options],{onOutput})}
  async openFileSession({writable=false}:{writable?:boolean}={}){
    const {handle}=await this.#client.request('kernel.openFileSession',[writable]);let closed=false
    return {call:async(method:string,args:unknown[])=>{if(closed)throw Error('EBADF: file session closed');return this.#client.request('file.call',[handle,method,args])},close:async()=>{if(closed)return;closed=true;await this.#client.request('file.close',[handle])}}
  }
  async spawn(command:string,args:string[]=[],options:SpawnOptions={}){
    const {handle,pid}=await this.#client.request('kernel.spawn',[command,args,options]);let disposing:Promise<void>|undefined
    return {pid,next:():Promise<ProcessEvent|null>=>this.#client.request('process.next',[handle]),write:async(value:Uint8Array|string)=>{const bytes=typeof value==='string'?new TextEncoder().encode(value):value;for(let offset=0;offset<bytes.length;offset+=16384)await this.#client.request('process.write',[handle,bytes.slice(offset,offset+16384)])},end:()=>this.#client.request('process.end',[handle]),wait:():Promise<KernelProcessResult>=>this.#client.request('process.wait',[handle]),kill:(signal='SIGTERM'):Promise<boolean>=>this.#client.request('process.kill',[handle,signal]),dispose:()=>disposing??=this.#client.request('process.dispose',[handle])}
  }
  async spawnShell(script:string,options:SpawnOptions={}){
    const {handle,pid}=await this.#client.request('kernel.spawnShell',[script,options]);let disposing:Promise<void>|undefined
    return {pid,next:():Promise<ProcessEvent|null>=>this.#client.request('process.next',[handle]),write:async(value:Uint8Array|string)=>{const bytes=typeof value==='string'?new TextEncoder().encode(value):value;for(let offset=0;offset<bytes.length;offset+=16384)await this.#client.request('process.write',[handle,bytes.slice(offset,offset+16384)])},end:()=>this.#client.request('process.end',[handle]),wait:():Promise<KernelProcessResult>=>this.#client.request('process.wait',[handle]),kill:(signal='SIGTERM'):Promise<boolean>=>this.#client.request('process.kill',[handle,signal]),dispose:()=>disposing??=this.#client.request('process.dispose',[handle])}
  }
  async connect(port:number,host='127.0.0.1'){
    const socket=await this.#client.request('kernel.connect',[port,host])
    return {port:socket.port,remotePort:socket.remotePort,read:():Promise<NetworkEvent|null>=>this.#client.request('socket.read',[socket.handle]),write:(bytes:Uint8Array)=>this.#client.request('socket.write',[socket.handle,bytes]),end:()=>this.#client.request('socket.end',[socket.handle]),close:()=>this.#client.request('socket.close',[socket.handle])}
  }
  async mountPreview(container:HTMLElement,options:HostedPreviewOptions){
    if(this.#closed)throw Error('HostedKernel closed')
    if(this.#frame.parentElement!==container)throw Error('Hosted preview container must be supplied when creating the kernel')
    this.#frame.removeAttribute('aria-hidden')
    Object.assign(this.#frame.style,{position:'static',left:'auto',top:'auto',width:'100%',height:'100%',border:'0',pointerEvents:'auto',opacity:'1'})
    try{await this.#client.request('kernel.mountPreview',[options])}
    catch(error){throw error}
    let closed=false
    return {
      frame:this.#frame,
      inspect:()=>this.#client.request('preview.inspect',[],{timeoutMs:7_500}),
      click:(selector:string)=>this.#client.request('preview.click',[selector],{timeoutMs:7_500}),
      close:async()=>{if(closed)return;closed=true;await this.#client.request('kernel.closePreview',[],{timeoutMs:7_500})},
    }
  }
  close(){
    if(this.#closed)return
    this.#closed=true
    void this.#client.request('kernel.close',[]).then(()=>{this.disconnect();this.#shutdownResolve()},error=>{this.disconnect();this.#shutdownReject(error)})
  }
  /** Forcefully detaches the host frame. Prefer close() when cooperative cleanup evidence is required. */
  disconnect(){
    const forced=!this.#closed
    this.#closed=true
    if(!this.#client.closed)this.#client.disconnect()
    this.#frame.remove()
    if(forced)this.#shutdownResolve()
  }
}

function randomNonce(){
  const bytes=new Uint8Array(18)
  if(!globalThis.crypto?.getRandomValues)throw Error('HostedKernel requires Web Crypto')
  crypto.getRandomValues(bytes)
  return [...bytes].map(value=>value.toString(16).padStart(2,'0')).join('')
}
function withTimeout<T>(promise:Promise<T>,ms:number,message:string){return new Promise<T>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(`${message} (${ms}ms)`)),ms);promise.then(value=>{clearTimeout(timer);resolve(value)},error=>{clearTimeout(timer);reject(error)})})}
