import {EventEmitter} from 'events'
import {PassThrough} from 'stream-browserify'
import {getNativeSyncFileClient,readVolume,vol} from '../vite-browser/node-fs'
import {forwardWorkerPort} from './worker-network'
import {createNativeSyncFileLane,NativeSyncFileHost} from './sync-file-bridge'
import {createNativeSyncPortLane,NativeSyncPortHost} from './sync-port-bridge'
import {network} from '../vite-browser/runtime-network'
import {isNativeTypecheck,isNativeViteBuild,isNativeViteDev} from './command-classification'
import {observeWorkspaceEvents} from './workspace-events'
import {keepNodeCommandAlive} from '../vite-browser/node-timers'
import {NativeCommandInputTransport} from './command-input-transport'
import browserProcess from 'process/browser'
import {getProcessDirectory} from './shared-working-directory'
import {resolveWorkerProgram,workerExecArgv} from './worker-entry'
import {nativeWorkerKind} from './worker-kind'
import {linkNativeFilesystemWorker} from './filesystem-worker-link.mjs'
import {getNativeFilesystemProvider} from './filesystem-provider.mjs'

type ThreadOptions={workerData?:unknown;transferList?:readonly Transferable[];env?:Record<string,string>;stdout?:boolean;stderr?:boolean;command?:boolean;argv?:string[];cwd?:string;eval?:boolean;evalSource?:string;stdinSource?:boolean;inheritedInput?:boolean;fork?:boolean;ipcSerialization?:'json'|'advanced';execArgv?:string[]}
type ThreadMessage={type:string;value?:unknown;files?:Record<string,Uint8Array>;packageRoots?:string[];entry?:string;workerData?:unknown;env?:Record<string,string>;argv?:string[];cwd?:string;evalSource?:string;fork?:boolean;stream?:'stdout'|'stderr';text?:string;bytes?:Uint8Array;outputId?:number;filePort?:MessagePort;fileLane?:SharedArrayBuffer;portPort?:MessagePort;portLane?:SharedArrayBuffer;error?:string;code?:number;port?:number;phase?:string;event?:{type:'open'|'close';port:number}}

export let isMainThread=true
export let workerData:unknown
export let parentPort:ThreadParentPort|null=null
let nextThreadId=0
const activeWorkers=new Map<Worker,()=>Promise<number|undefined>>()

export async function disposeNativeWorkers(){
  // Ending the owner does not run guest child-exit callbacks, just as exiting
  // a Node process does not dispatch its remaining workers' exit listeners.
  const results=await Promise.allSettled([...activeWorkers.values()].map(close=>close()))
  const errors=results.filter(result=>result.status==='rejected').map(result=>result.reason)
  if(errors.length)throw new AggregateError(errors,'Native worker cleanup failed')
}

class ThreadParentPort extends EventEmitter{
  #started=false
  #closed=false
  #pending:unknown[]=[]
  #flushPending=false
  #releaseActivity:(()=>void)|undefined
  #onRemoved=(event:string|symbol)=>{if(event==='message'&&!this.listenerCount('message'))this.unref()}
  constructor(){
    super()
    this.on('removeListener',this.#onRemoved)
  }
  override removeAllListeners(event?:string|symbol){
    if(event===undefined)super.removeAllListeners()
    else super.removeAllListeners(event)
    if(!this.#closed&&!this.listeners('removeListener').includes(this.#onRemoved))
      super.on('removeListener',this.#onRemoved)
    return this
  }
  ref(){if(!this.#closed&&!this.#releaseActivity)this.#releaseActivity=keepNodeCommandAlive()}
  unref(){this.#releaseActivity?.();this.#releaseActivity=undefined}
  hasRef(){return !this.#closed&&!!this.#releaseActivity}
  override on(event:string|symbol,listener:(...args:any[])=>void){
    super.on(event,listener)
    if(event==='message'&&!this.#closed){
      if(this.listenerCount('message')===1)this.ref()
      this.#started=true
      if(!this.#flushPending){
        this.#flushPending=true
        queueMicrotask(()=>{
          while(!this.#closed&&this.#pending.length)this.emit('message',this.#pending.shift())
          this.#flushPending=false
        })
      }
    }
    return this
  }
  override addListener(event:string|symbol,listener:(...args:any[])=>void){return this.on(event,listener)}
  receive(value:unknown){
    if(this.#closed)return
    if(!this.#started||this.#flushPending)this.#pending.push(value)
    else this.emit('message',value)
  }
  postMessage(value:unknown,transferList:readonly Transferable[]=[]){
    if(this.#closed)return
    self.postMessage({type:'native-thread-message',value},[...transferList])
  }
  close(){
    if(this.#closed)return
    this.#closed=true
    this.#pending.length=0
    queueMicrotask(()=>{try{this.emit('close')}finally{this.removeAllListeners()}})
    this.unref()
  }
}

export function enterNativeThread(data:unknown){
  isMainThread=false
  workerData=adaptTransferredPorts(data)
  parentPort=new ThreadParentPort()
}

export function receiveNativeThreadMessage(value:unknown){parentPort?.receive(adaptTransferredPorts(value))}

function installedBindingRoots(){
  const roots:string[]=[]
  const visit=(directory:string)=>{
    for(const entry of vol.readdirSync(directory,{withFileTypes:true})){
      if(typeof entry!=='object'||!('isDirectory' in entry)||!('name' in entry))
        throw Error('Expected a directory entry from memfs')
      if(!entry.isDirectory())continue
      const path=`${directory}/${entry.name}`
      if((path.endsWith('/node_modules/lightningcss')||path.endsWith('/node_modules/@tailwindcss/oxide'))&&
        vol.existsSync(`${path}/package.json`))roots.push(path)
      visit(path)
    }
  }
  visit('/app')
  return roots
}

export class Worker extends EventEmitter{
  readonly stdout=new PassThrough()
  readonly stderr=new PassThrough()
  readonly threadId=++nextThreadId
  readonly #worker:globalThis.Worker
  readonly #startup:ThreadMessage & {stdinSource?:boolean;ipcSerialization?:'json'|'advanced';execArgv?:string[];cwdBuffer?:SharedArrayBuffer}
  readonly #fileHost:NativeSyncFileHost
  readonly #filesystemLink:ReturnType<typeof linkNativeFilesystemWorker>
  readonly #portHost:NativeSyncPortHost
  readonly #command:boolean
  readonly #viteDev:boolean
  readonly #pending:Array<{value:unknown;transferList:Transferable[]}>=[]
  readonly #input:NativeCommandInputTransport
  readonly #ports=new Map<number,()=>void>()
  readonly #unpublishedPorts=new Set<number>()
  readonly #workspaceWatcher:ReturnType<typeof vol.watch>|undefined
  #startupTimer:ReturnType<typeof setTimeout>|undefined
  #phase='bootstrapping'
  #ready=false
  #pendingIpcDisconnect=false
  #closed=false
  #changedPaths:string[]=[]
  #termination:Promise<number>|undefined
  #releaseActivity:(()=>void)|undefined
  constructor(filename:string|URL,options:ThreadOptions={}){
    super()
    const program=resolveWorkerProgram(filename,options.eval?options.cwd??browserProcess.cwd():browserProcess.cwd(),options.eval)
    const entry=program.entry
    const evalSource=options.eval?program.evalSource:options.evalSource
    // Node snapshots starting data and transfers ownership during construction,
    // not when the child eventually finishes loading its runtime.
    const startingData=structuredClone({workerData:options.workerData,transferList:[...(options.transferList??[])]},
      {transfer:[...(options.transferList??[])]})
    this.#command=options.command===true
    const execArgv=workerExecArgv(options.execArgv,(browserProcess as unknown as {execArgv?:string[]}).execArgv??[],this.#command)
    if(!this.#command){
      for(const name of ['stdout','stderr'] as const){
        const output=(browserProcess as unknown as Record<string,any>)[name]
        if(options[name]!==true&&output?.write)this[name].pipe(output,{end:false})
      }
    }
    const typecheck=this.#command&&isNativeTypecheck(entry,options.argv??[],options.evalSource)
    const viteBuild=this.#command&&isNativeViteBuild(entry,options.argv??[],options.evalSource)
    const viteDev=this.#command&&isNativeViteDev(entry,options.argv??[],options.evalSource)
    this.#viteDev=viteDev
    const url=new URL(self.location.href)
    url.searchParams.delete('native-command')
    url.searchParams.delete('native-thread')
    url.searchParams.delete('native-typecheck')
    url.searchParams.set(this.#command?'native-command':'native-thread','1')
    if(typecheck)url.searchParams.set('native-typecheck','1')
    this.#worker=new globalThis.Worker(url,{type:nativeWorkerKind()})
    this.#filesystemLink=linkNativeFilesystemWorker(this.#worker)
    this.#input=new NativeCommandInputTransport(message=>this.#worker.postMessage(message))
    this.#workspaceWatcher=this.#command?observeWorkspaceEvents(vol,'/app',(event,path)=>{
      if(this.#closed)return
      this.#worker.postMessage({type:'native-thread-file-change',event,path})
    }):undefined
    const channel=new globalThis.MessageChannel()
    const lane=createNativeSyncFileLane()
    this.#fileHost=new NativeSyncFileHost(vol,channel.port1,lane,getNativeSyncFileClient())
    const portChannel=new globalThis.MessageChannel()
    const portLane=createNativeSyncPortLane()
    this.#portHost=new NativeSyncPortHost(network,portChannel.port1,portLane)
    // Evaluated Node commands resolve files through their live file lane.
    // They do not need a second copy of the project before they can start.
    const files=this.#filesystemLink||this.#command&&(options.evalSource!==undefined||options.stdinSource||viteBuild||viteDev||typecheck)?{}:readVolume('/app')
    const packageRoots=viteBuild||viteDev?installedBindingRoots():undefined
    const fileBuffers=[...new Set(Object.values(files).map(bytes=>bytes.buffer))]
    const snapshotSize=Object.values(files).reduce((total,bytes)=>total+bytes.byteLength,0)
    this.#startup={type:'native-thread-start',files,packageRoots,entry,workerData:startingData.workerData,env:{...(options.env??browserProcess.env)},
      argv:options.argv,cwd:options.cwd??browserProcess.cwd(),cwdBuffer:this.#command?undefined:getProcessDirectory(browserProcess.cwd()).buffer,evalSource,stdinSource:options.stdinSource,fork:options.fork,ipcSerialization:options.ipcSerialization,execArgv,
      inheritedInput:options.inheritedInput,filePort:channel.port2,fileLane:lane,portPort:portChannel.port2,portLane}
    this.#worker.onmessage=({data}:MessageEvent<ThreadMessage>)=>{
      if(data.type==='native-dev-progress'&&typeof data.phase==='string'){
        this.#phase=data.phase
        self.postMessage({type:'native-dev-progress',phase:`worker:${this.threadId}:${data.phase}`})
      }
      else if(data.type==='native-thread-bootstrap-ready'){
        this.#phase=`loading workspace (${fileBuffers.length} files, ${Math.ceil(snapshotSize/1048576)} MiB)`
        try{
          this.#worker.postMessage(this.#startup,[channel.port2,portChannel.port2,...fileBuffers,...startingData.transferList])
          this.#startup.files=undefined
        }catch(error){this.#fail(error instanceof Error?error:Error(String(error)))}
      }
      else if(data.type==='native-thread-ready'){
        this.#clearStartupTimer()
        this.#phase='running'
        this.#ready=true
        this.emit('online')
        for(const message of this.#pending)this.#worker.postMessage({type:'native-thread-message',value:message.value},message.transferList)
        this.#pending.length=0
        if(this.#pendingIpcDisconnect){this.#pendingIpcDisconnect=false;this.#worker.postMessage({type:'native-thread-disconnect'})}
        this.#input.start()
      }else if(data.type==='native-thread-input-demand')this.emit('input-demand')
      else if(data.type==='native-thread-input-ack')this.#input.acknowledge((data as ThreadMessage&{inputId:number}).inputId)
      else if(data.type==='native-thread-message')this.emit('message',adaptTransferredPorts(data.value))
      else if(data.type==='native-thread-disconnect')this.emit('disconnect')
      else if(data.type==='native-thread-output'&&data.stream&&data.bytes instanceof Uint8Array){
        let acknowledged=false
        const done=()=>{
          if(acknowledged||this.#closed)return
          acknowledged=true
          if(typeof data.outputId==='number')this.#worker.postMessage({type:'native-thread-output-ack',outputId:data.outputId})
        }
        if(this.#command){if(!this.emit(`${data.stream}-bytes`,data.bytes,done))done()}
        else this[data.stream].write(data.bytes,done)
      }
      else if(data.type==='native-thread-output'&&data.stream&&typeof data.text==='string'){
        // Internal command workers already stream through terminal/child events.
        // Do not retain a second unread copy of their output.
        if(!this.#command)this[data.stream].write(data.text)
        this.emit(data.stream,data.text)
      }
      else if(data.type==='native-thread-port'&&data.event){
        if(data.event.type==='open'&&!this.#ports.has(data.event.port)){
          if(this.#viteDev){this.#unpublishedPorts.add(data.event.port);return}
          try{
            const reserved=this.#portHost.owns(data.event.port)
            if(reserved)this.#portHost.claim(data.event.port)
            this.#ports.set(data.event.port,forwardWorkerPort(this.#worker,data.event.port,reserved))
          }
          catch(error){this.emit('error',error)}
        }else if(data.event.type==='close'){
          if(this.#unpublishedPorts.delete(data.event.port))this.#portHost.release(data.event.port)
          this.#ports.get(data.event.port)?.()
          this.#ports.delete(data.event.port)
        }
      }
      else if(data.type==='native-thread-server-ready'&&this.#viteDev&&Number.isInteger(data.port)&&
        (data.port as number)>0&&(data.port as number)<=65535){
        const port=data.port as number
        if(!this.#unpublishedPorts.delete(port)||this.#ports.has(port))return
        try{
          const reserved=this.#portHost.owns(port)
          if(reserved)this.#portHost.claim(port)
          this.#ports.set(port,forwardWorkerPort(this.#worker,port,reserved))
        }catch(error){this.emit('error',error)}
      }
      else if(data.type==='native-thread-error'){
        const error=Error(data.error??'Native worker failed')
        Object.assign(error,{diagnostic:(data as ThreadMessage&{diagnostic?:unknown}).diagnostic})
        this.#fail(error)
      }
      else if(data.type==='native-thread-exit'){
        if(this.#closed)return
        this.unref()
        activeWorkers.delete(this)
        this.#clearStartupTimer()
        this.#workspaceWatcher?.close()
        this.#closed=true;this.#input.close();this.#fileHost.close();this.#portHost.close()
        for(const stop of this.#ports.values())stop()
        this.#ports.clear()
        this.#releaseFilesystem();this.#worker.terminate()
        this.#endOutput()
        this.emit('exit',data.code??0)
      }
    }
    this.#worker.onerror=event=>this.#fail(Error(event.message))
    this.#worker.onmessageerror=()=>this.#fail(Error('Native worker message could not be decoded'))
    this.#startupTimer=setTimeout(()=>this.#fail(Error(`Native worker timed out while ${this.#phase}`)),30000)
    activeWorkers.set(this,()=>this.#terminate(false))
    this.ref()
  }
  ref(){if(!this.#closed&&!this.#releaseActivity)this.#releaseActivity=keepNodeCommandAlive()}
  unref(){this.#releaseActivity?.();this.#releaseActivity=undefined}
  get phase(){return this.#phase}
  #endOutput(){this.stdout.end();this.stderr.end()}
  #clearStartupTimer(){
    if(this.#startupTimer!==undefined)clearTimeout(this.#startupTimer)
    this.#startupTimer=undefined
  }
  #fail(error:Error){
    if(this.#closed)return
    this.unref()
    this.#clearStartupTimer()
    this.#workspaceWatcher?.close()
    this.#closed=true
    this.#input.close()
    activeWorkers.delete(this)
    this.#fileHost.close();this.#portHost.close()
    for(const stop of this.#ports.values())stop()
    this.#ports.clear()
    this.#releaseFilesystem();this.#worker.terminate()
    this.#endOutput()
    try{this.emit('error',error)}
    finally{this.emit('exit',1)}
  }
  postMessage(value:unknown,transferList:readonly Transferable[]=[]){
    if(this.#closed)return
    if(this.#ready)this.#worker.postMessage({type:'native-thread-message',value},[...transferList])
    else{
      if(this.#pending.length>=1024)throw Error('Worker message queue is full')
      this.#pending.push(structuredClone({value,transferList:[...transferList]},{transfer:[...transferList]}))
    }
  }
  writeInput(bytes:Uint8Array|null){
    if(!this.#command||this.#closed)throw Error('Command input is unavailable')
    return this.#input.write(bytes)
  }
  disconnectIpc(){
    if(this.#closed)return
    if(this.#ready)this.#worker.postMessage({type:'native-thread-disconnect'})
    else this.#pendingIpcDisconnect=true
  }
  #releaseFilesystem(){
    if(!this.#filesystemLink)return
    try{this.#changedPaths=getNativeFilesystemProvider()!.changedPaths(this.#filesystemLink.id)}
    finally{this.#filesystemLink.dispose()}
  }
  get changedPaths(){return this.#filesystemLink?this.#changedPaths:this.#fileHost.files.workspaceChangedPaths}
  async terminate(){
    return this.#terminate(true)
  }
  async #terminate(emitExit:boolean){
    if(this.#termination)return this.#termination
    if(this.#closed)return undefined
    const code=this.#ready?1:0
    this.#clearStartupTimer()
    this.#workspaceWatcher?.close()
    this.#closed=true
    this.#input.close()
    activeWorkers.delete(this)
    this.#fileHost.close();this.#portHost.close()
    for(const stop of this.#ports.values())stop()
    this.#ports.clear()
    this.#releaseFilesystem();this.#worker.terminate()
    this.#endOutput()
    this.#termination=new Promise<number>((resolve,reject)=>{
      queueMicrotask(()=>{
        try{if(emitExit)this.emit('exit',code);resolve(code)}
        catch(error){reject(error)}
        finally{this.unref();this.#termination=undefined}
      })
    })
    return this.#termination
  }
}

import {MessageChannel,MessagePort,adaptTransferredPorts} from './message-port'
export {MessageChannel,MessagePort}
export function receiveMessageOnPort(_port:unknown):never{
  // Browser MessagePort does not expose its queue for synchronous reads.
  // Returning undefined here would falsely report that queued messages are absent.
  throw Object.assign(Error('Synchronous MessagePort reads require a worker-owned message queue'),
    {code:'ERR_UNSUPPORTED_OPERATION'})
}
export default {Worker,MessageChannel,MessagePort,receiveMessageOnPort}
