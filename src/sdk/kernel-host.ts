import {SDK_COMPATIBILITY,WorkerKernel} from './index'
import type {KernelOwnerOptions,KernelOptions,SpawnOptions,WorkspaceSnapshot} from './index'
import {WorkerHTTP} from '../sandbox/worker-http'
import {WorkerWebSocket} from '../sandbox/worker-websocket'
import {URLPreview} from '../sandbox/url-preview'
import {previewRequestTimeout,previewStartupTimeout} from '../sandbox/request-timeouts'
import {HOST_OPERATIONS,HOST_PROTOCOL_VERSION,hostError,parseHostAttachMessage,parseHostClientMessage} from './host-protocol'
import type {HostAttachMessage,HostCancel,HostRequest,HostServerMessage} from './host-protocol'

type ProcessHandle=Awaited<ReturnType<WorkerKernel['spawn']>>
type SocketHandle=Awaited<ReturnType<WorkerKernel['connect']>>
type FileHandle=Awaited<ReturnType<WorkerKernel['openFileSession']>>
type KernelFactory=(files:Record<string,string|Uint8Array>,options:KernelOwnerOptions)=>WorkerKernel

const integer=(value:unknown,name:string)=>{
  if(!Number.isSafeInteger(value)||Number(value)<1)throw new TypeError(`${name} must be a positive integer`)
  return Number(value)
}
const argumentsOf=(value:unknown)=>{
  if(value===undefined)return []
  if(!Array.isArray(value))throw new TypeError('Request args must be an array')
  return value
}

/** Owns one kernel and every resource handle created through it. */
export class KernelHostDispatcher {
  #kernel:WorkerKernel|undefined
  #processes=new Map<number,ProcessHandle>()
  #sockets=new Map<number,SocketHandle>()
  #files=new Map<number,FileHandle>()
  #nextHandle=0
  #preview:Awaited<ReturnType<typeof URLPreview.mount>>|undefined
  #unsubscribePorts:(()=>void)|undefined
  #closing:Promise<void>|undefined
  constructor(private readonly send:(message:HostServerMessage)=>void,private readonly createKernel:KernelFactory=(files,options)=>new WorkerKernel(files,options)){}
  #ownedKernel(){if(!this.#kernel)throw Error('Kernel has not been created');return this.#kernel}
  #handle<T>(map:Map<number,T>,value:T){const id=++this.#nextHandle;map.set(id,value);return id}
  #owned<T>(map:Map<number,T>,value:unknown,kind:string){const id=integer(value,`${kind} handle`),handle=map.get(id);if(!handle)throw Error(`Unknown ${kind} handle: ${id}`);return {id,handle}}
  async dispatch(request:HostRequest,signal:AbortSignal):Promise<unknown>{
    const args=argumentsOf(request.args)
    signal.throwIfAborted()
    switch(request.operation){
      case 'kernel.create': {
        if(this.#kernel)throw Error('Kernel already created')
        const [files={},options={}] = args as [Record<string,string|Uint8Array>?,KernelOwnerOptions?]
        const kernel=this.createKernel(files??{},options??{})
        this.#kernel=kernel
        this.#unsubscribePorts=kernel.subscribePorts(event=>this.send({type:'port',event} satisfies HostServerMessage))
        return
      }
      case 'kernel.snapshot': return this.#ownedKernel().snapshot()
      case 'kernel.restore': return this.#ownedKernel().restore(args[0] as WorkspaceSnapshot)
      case 'kernel.saveCheckpoint': return this.#ownedKernel().saveCheckpoint(String(args[0]))
      case 'kernel.restoreCheckpoint': return this.#ownedKernel().restoreCheckpoint(String(args[0]))
      case 'kernel.checkpointMetadata': return this.#ownedKernel().checkpointMetadata(String(args[0]))
      case 'kernel.deleteCheckpoint': return this.#ownedKernel().deleteCheckpoint(String(args[0]))
      case 'kernel.readFile': return args[1]==='utf8'?this.#ownedKernel().readText(String(args[0])):this.#ownedKernel().readFile(String(args[0]))
      case 'kernel.writeFile': return this.#ownedKernel().writeFile(String(args[0]),args[1] as Uint8Array)
      case 'kernel.install': return this.#ownedKernel().install((args[0]??{}) as Parameters<WorkerKernel['install']>[0],signal)
      case 'kernel.resources': return this.#ownedKernel().resources()
      case 'kernel.execute': return this.#ownedKernel().execute(String(args[0]),this.#outputOptions(request.id,args[1]))
      case 'kernel.run': return this.#ownedKernel().run(String(args[0]),this.#outputOptions(request.id,args[1]))
      case 'kernel.runModule': return this.#ownedKernel().runModule(String(args[0]),this.#outputOptions(request.id,args[1]))
      case 'kernel.spawn': {
        const process=await this.#ownedKernel().spawn(String(args[0]),(args[1]??[]) as string[],(args[2]??{}) as SpawnOptions)
        return {handle:this.#handle(this.#processes,process),pid:process.pid}
      }
      case 'kernel.spawnShell': {
        const process=await this.#ownedKernel().spawnShell(String(args[0]),(args[1]??{}) as SpawnOptions)
        return {handle:this.#handle(this.#processes,process),pid:process.pid}
      }
      case 'process.next': return this.#owned(this.#processes,args[0],'process').handle.next()
      case 'process.write': return this.#owned(this.#processes,args[0],'process').handle.write(args[1] as string|Uint8Array)
      case 'process.end': return this.#owned(this.#processes,args[0],'process').handle.end()
      case 'process.wait': return this.#owned(this.#processes,args[0],'process').handle.wait()
      case 'process.kill': return this.#owned(this.#processes,args[0],'process').handle.kill(args[1]===undefined?undefined:String(args[1]))
      case 'process.dispose': {
        const {id,handle}=this.#owned(this.#processes,args[0],'process');await handle.dispose();this.#processes.delete(id);return
      }
      case 'kernel.connect': {
        const socket=await this.#ownedKernel().connect(Number(args[0]),args[1]===undefined?undefined:String(args[1]))
        return {handle:this.#handle(this.#sockets,socket),port:socket.port,remotePort:socket.remotePort}
      }
      case 'socket.read': return this.#owned(this.#sockets,args[0],'socket').handle.read()
      case 'socket.write': return this.#owned(this.#sockets,args[0],'socket').handle.write(args[1] as Uint8Array)
      case 'socket.end': return this.#owned(this.#sockets,args[0],'socket').handle.end()
      case 'socket.close': {
        const {id,handle}=this.#owned(this.#sockets,args[0],'socket');await handle.close();this.#sockets.delete(id);return
      }
      case 'kernel.openFileSession': {
        const file=await this.#ownedKernel().openFileSession({writable:args[0]===true})
        return {handle:this.#handle(this.#files,file)}
      }
      case 'kernel.mountPreview': {
        if(this.#preview)throw Error('Preview already mounted')
        const options=args[0] as {origin?:unknown;port?:unknown;path?:unknown;requestTimeoutMs?:unknown;startupTimeoutMs?:unknown}
        if(typeof options?.origin!=='string'||!Number.isSafeInteger(options.port)||Number(options.port)<1||Number(options.port)>65535||(options.path!==undefined&&typeof options.path!=='string'))throw Error('Invalid hosted preview options')
        const requestTimeoutMs=previewRequestTimeout(options.requestTimeoutMs as number|undefined),startupTimeoutMs=previewStartupTimeout(options.startupTimeoutMs as number|undefined)
        const kernel=this.#ownedKernel(),port=Number(options.port),container=document.getElementById('preview')
        if(!container)throw Error('Kernel host preview container is missing')
        this.#preview=await URLPreview.mount(container,{origin:options.origin,path:options.path as string|undefined,requestTimeoutMs,startupTimeoutMs,server:new WorkerHTTP(kernel,port,{requestTimeoutMs}),connectWebSocket:(url,protocols)=>WorkerWebSocket.connect(kernel,port,options.origin as string,url,protocols)})
        return
      }
      case 'kernel.closePreview': this.#preview?.close();this.#preview=undefined;return
      case 'preview.inspect': if(!this.#preview)throw Error('Preview is not mounted');return this.#preview.inspect()
      case 'preview.click': if(!this.#preview)throw Error('Preview is not mounted');return this.#preview.click(String(args[0]))
      case 'file.call': return this.#owned(this.#files,args[0],'file').handle.call(String(args[1]),(args[2]??[]) as unknown[])
      case 'file.close': {
        const {id,handle}=this.#owned(this.#files,args[0],'file');await handle.close();this.#files.delete(id);return
      }
      case 'kernel.close': await this.close();return
      default: throw Error(`Unsupported host operation: ${String(request.operation)}`)
    }
  }
  #outputOptions(requestId:number,value:unknown):KernelOptions{
    const options=value&&typeof value==='object'?value as KernelOptions:{}
    return {...options,onOutput:(level,text)=>this.send({type:'output',requestId,level,text} satisfies HostServerMessage)}
  }
  close(){return this.#closing??=this.#close()}
  async #close(){
    this.#preview?.close();this.#preview=undefined
    this.#unsubscribePorts?.();this.#unsubscribePorts=undefined
    await Promise.allSettled([
      ...[...this.#processes.values()].map(process=>process.dispose()),
      ...[...this.#sockets.values()].map(socket=>socket.close()),
      ...[...this.#files.values()].map(file=>file.close()),
    ])
    this.#processes.clear();this.#sockets.clear();this.#files.clear()
    const kernel=this.#kernel;this.#kernel=undefined
    if(kernel){kernel.close();await kernel.shutdown}
  }
}

export interface KernelHostConfiguration {ownerOrigin:string;nonce:string;buildId:string}

export function readKernelHostConfiguration(url=new URL(location.href),documentValue:Document=document):KernelHostConfiguration{
  const ownerOrigin=url.searchParams.get('ownerOrigin')??''
  const nonce=url.searchParams.get('nonce')??''
  let parsed:URL
  try{parsed=new URL(ownerOrigin)}catch{throw Error('Missing or invalid kernel host ownerOrigin')}
  if(parsed.origin!==ownerOrigin||!['http:','https:'].includes(parsed.protocol))throw Error('Kernel host ownerOrigin must be an exact HTTP origin')
  if(!nonce||nonce.length>256)throw Error('Missing or invalid kernel host nonce')
  return {ownerOrigin,nonce,buildId:url.searchParams.get('buildId')??documentValue.querySelector<HTMLMetaElement>('meta[name="browser-sandbox-build-id"]')?.content??'development'}
}

/** Installs the one-shot parent handshake used by the isolated kernel host iframe. */
export function bootstrapKernelHost(configuration=readKernelHostConfiguration(),scope:Window=window){
  let attached=false
  const attach=(event:MessageEvent)=>{
    if(attached||event.source!==scope.parent||event.origin!==configuration.ownerOrigin)return
    let value:HostAttachMessage
    try{value=parseHostAttachMessage(event.data)}catch{return}
    if(value.nonce!==configuration.nonce||value.ownerOrigin!==configuration.ownerOrigin||event.ports.length!==1)return
    attached=true;scope.removeEventListener('message',attach)
    const port=event.ports[0],controllers=new Map<number,AbortController>()
    const send=(message:HostServerMessage)=>port.postMessage(message)
    const dispatcher=new KernelHostDispatcher(send)
    send({type:'attached',protocolVersion:HOST_PROTOCOL_VERSION,nonce:configuration.nonce,capabilities:{protocolVersion:HOST_PROTOCOL_VERSION,buildId:configuration.buildId,apiVersion:SDK_COMPATIBILITY.apiVersion,crossOriginIsolated:globalThis.crossOriginIsolated===true,sharedArrayBuffer:typeof SharedArrayBuffer==='function',indexedDB:typeof indexedDB!=='undefined',operations:HOST_OPERATIONS}})
    port.onmessage=message=>{
      let data:HostRequest|HostCancel
      try{data=parseHostClientMessage(message.data)}catch{return}
      if(data.type==='cancel'){controllers.get(data.requestId)?.abort();return}
      if(controllers.has(data.id)){send({type:'error',id:data.id,error:{name:'Error',message:'Duplicate request id'}});return}
      const controller=new AbortController();controllers.set(data.id,controller)
      void dispatcher.dispatch(data,controller.signal).then(
        value=>send({type:'result',id:data.id,value}),
        error=>send({type:'error',id:data.id,error:hostError(error)}),
      ).finally(()=>{
        controllers.delete(data.id)
        if(data.operation==='kernel.close'){send({type:'closed'});port.close()}
      })
    }
    port.onmessageerror=()=>{
      const reason=hostError(Error('Browser sandbox host received an unreadable message'))
      void dispatcher.close().finally(()=>{send({type:'closed',reason});port.close()})
    }
    port.start()
  }
  scope.addEventListener('message',attach)
  return ()=>scope.removeEventListener('message',attach)
}

if(typeof window!=='undefined'&&window.parent!==window)bootstrapKernelHost()
