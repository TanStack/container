import {createKernelWorker} from './worker-factories'
import {compilerPolicy} from '../compiler/compiler-policy'
import {rolldownParserPolicy} from '../compiler/rolldown-parser-policy'
import type {WorkerMessageSample} from './worker-message-timing'
import type {TaskSchedulerSample} from './task-scheduler'
import type {GuestSample,GuestSamplingSnapshot} from './guest-sampling'
import {compile} from './compile'
import type {WorkspaceSnapshot} from './files'
import type {CheckpointMetadata} from './checkpoint-storage'
import type {ExecutionResult} from './process'
import {kernelLimits,workspaceLimits,sharedMemoryPerEngineLimits,workerMemoryLimit,type KernelLimits,type KernelOwnerOptions} from './kernel-limits'
import type {ProjectInstallOptions,ProjectInstallResult} from '../npm/project'
import type {NetworkEvent,PortEvent} from './virtual-network'
import type {ProcessEvent,SpawnOptions} from './guest-processes'
import {resolveRuntimeAssetBase} from './runtime-assets'
import {kernelRequestDeadlines} from './kernel-request-timeout'
export type {ProcessEvent,SpawnOptions} from './guest-processes'

export interface ExternalFetchPolicy {
  /** Exact HTTPS origins the guest may read, for example https://api.example.com. */
  allowedOrigins:string[]
  /** Maximum requests during one guest execution. Defaults to 32, maximum 128. */
  maxRequests?:number
  /** Maximum bytes per response. Defaults to 8 MiB, maximum 32 MiB. */
  maxResponseBytes?:number
  /** Maximum response bytes across one guest execution. Defaults to 32 MiB, maximum 64 MiB. */
  maxTotalBytes?:number
}
export interface KernelOptions {maxBytes?:number;timeoutMs?:number;webAPIs?:boolean;writable?:boolean;guestWasm?:boolean;diagnostics?:boolean;cwd?:string;
  /** Opt-in fine-grained profiler. Runs one guest promise job per batch instead of 100,
   * changing scheduling and adding overhead. Leave disabled for normal apps and
   * acceptance timings; use diagnostics for ordinary execution counters. */
  profileJobs?:boolean;
  /** Opt-in GET/HEAD of file:/// and https://workspace.invalid/ virtual files. Requires webAPIs. No network access. */
  workspaceFetch?:boolean;
  /** Opt-in, execution-scoped GET/HEAD access to exact HTTPS origins. Requires webAPIs. Disabled by default. */
  externalFetch?:ExternalFetchPolicy;
  onOutput?:(level:string,text:string)=>void}
export interface KernelExecutionResult extends ExecutionResult {
  wasmHeapBytes:number
  diagnostics?:{jobBatches:number;jobs:number;jobPumpMs:number;yieldCount:number;yieldWaitMs:number;fileCalls:number;fileCallMs:number;
    startup?:{engineMs:number;runtimeMs:number;contextMs:number;bootstrapMs?:number};
    failure?:{stage:string;type:string;isNull:boolean;memory:string}}
}
export interface KernelProcessResult extends KernelExecutionResult {signal:string|null}
export interface KernelProcessHandle {
  pid:number
  next:()=>Promise<ProcessEvent|null>
  write:(bytes:Uint8Array|string)=>Promise<void>
  end:()=>Promise<unknown>
  wait:()=>Promise<KernelProcessResult>
  kill:(signal?:string)=>Promise<boolean>
  dispose:()=>Promise<void>
}
export interface KernelResourceSnapshot {processes:{active:number;retained:number};network:{handles:number;listeners:number;details:ReturnType<import('./virtual-network').VirtualNetwork['snapshot']>};datagrams:{handles:number;bound:number};fileSessions:number;executing:boolean;installing:boolean;nativeParser:{enabled:boolean;state:'idle'|'opening'|'active'|'closing'|'closed'|'failed';reservedInitialBytes:number;reservedMaximumBytes:number;activeSessions:number;pendingCalls:number;completedCalls:number;failedCalls:number;pendingSourceBytes:number;maxPendingSourceBytes:number;shutdownPending:boolean;bundlers:{active:Array<{pid:number;state:import('../compiler/kernel-bundler-host').KernelBundlerSnapshot}>;retired:Array<{pid:number;state:import('../compiler/kernel-bundler-host').KernelBundlerSnapshot}>}}}
export interface WorkerStartFailure {pid:number;phase:'worker-start-failure';at:number;ms:number;jobs:number;workerStartError:{name:string;message:string};workerStartScheduling?:unknown}

// Experimental ownership model, separate from Workspace. The only live filesystem
// resides in this worker. Host tools use RPC, guest sync calls stay within it.
export class WorkerKernel {
  readonly assetBaseURL:string
  readonly workerLifecycle:{pid:number;sample:WorkerMessageSample}[]=[]
  readonly guestSamples:(GuestSample&{pid:number})[]=[]
  readonly guestSamplingErrors:{pid:number;error:string}[]=[]
  guestSamplesDropped=0
  guestSamplesOwnerDropped=0
  readonly hostTaskScheduling:{pid:number;count:number;dropped:number;hostTasks:TaskSchedulerSample[]}[]=[]
  readonly schedulerDiagnostics:{pid:number;phase:'live-scheduling';at:number;sequence:number;pendingFilesystemTasks:number;[key:string]:unknown}[]=[]
  readonly workerStartFailures:WorkerStartFailure[]=[]
  #workerStartFailuresDropped=0
  get workerStartFailuresDropped(){return this.#workerStartFailuresDropped}
  readonly jobProfile:{pid:number;ms:number;at:number;phase:string;jobs:number;importsMs?:number;imports?:number;interruptCalls?:number;interruptMs?:number;fileCalls?:number;fileCallMs?:number;cjsCompileCalls?:number;cjsCompileMs?:number;reason?:'cancelled'|'deadline';budget?:{lifetime:'bounded'|'session';timeoutMs:number;deadline:number|null;remainingMs:number|null};jobBatchLimit?:number;fiberTiming?:{steps:number;totalMs:number;maxMs:number;parked:number};completions?:{enqueued:number;drained:number;maxPending:number;totalWaitMs:number;maxWaitMs:number;oldestPendingMs:number}}[]=[]
  #worker:Worker
  #limits:Readonly<KernelLimits>
  #next=0
  #installationSequence=0
  #closed=false
  #ports=new Set<number>()
  #portListeners=new Set<(event:PortEvent)=>void>()
  /** Current sandbox TCP listening ports, returned as an independent sorted array. */
  get listeningPorts(){return [...this.#ports].sort((a,b)=>a-b)}
  /** Replays current opens synchronously. Observer exceptions are ignored. */
  subscribePorts(callback:(event:PortEvent)=>void){
    if(this.#closed)throw Error('Kernel closed')
    const listener=(event:PortEvent)=>callback(event)
    this.#portListeners.add(listener)
    for(const port of this.listeningPorts){
      if(this.#closed)break
      if(this.#ports.has(port))this.#notifyPort(listener,{type:'open',port})
    }
    return ()=>{this.#portListeners.delete(listener)}
  }
  #notifyPort(listener:(event:PortEvent)=>void,event:PortEvent){
    try{listener(Object.freeze({...event}))}catch{/* Observers cannot interrupt kernel lifecycle or other subscribers. */}
  }
  #port(event:PortEvent){
    if(this.#closed)return
    if(event.type==='open'){
      if(this.#ports.has(event.port))return
      this.#ports.add(event.port)
    }else{
      if(!this.#ports.delete(event.port))return
    }
    for(const listener of [...this.#portListeners]){
      if(this.#closed)break
      if(this.#portListeners.has(listener))this.#notifyPort(listener,event)
    }
  }
  #parserShutdownMs:number|undefined
  /** Resolves after optional native worker cleanup and kernel worker termination. */
  shutdown:Promise<void>|undefined
  #abort=new AbortController()
  #pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;output?:KernelOptions['onOutput'];timer:ReturnType<typeof setTimeout>;absoluteTimer?:ReturnType<typeof setTimeout>;renewHeartbeat?:()=>void;renewProgress?:()=>void}>()
  #ready:Promise<unknown>
  constructor(files:Record<string,string|Uint8Array>={},limits:KernelOwnerOptions={}){
    this.assetBaseURL=resolveRuntimeAssetBase(limits.assetBaseURL)
    this.#limits=kernelLimits(limits)
    const workerMaxBytes=workerMemoryLimit(this.#limits,limits.workerMaxBytes)
    const experimentalCompiler=compilerPolicy(limits.experimentalCompiler)
    const experimentalRolldownParser=rolldownParserPolicy(limits.experimentalRolldownParser)
    this.#parserShutdownMs=experimentalRolldownParser?experimentalRolldownParser.timeoutMs*2+1000:undefined
    const workspace=workspaceLimits(limits.workspace)
    const sharedMemoryPerEngine=sharedMemoryPerEngineLimits(limits.sharedMemoryPerEngine,limits.experimentalFibers)
    this.#worker=createKernelWorker(this.assetBaseURL)
    this.#worker.onmessage=event=>{
      if(event.data.type==='port'){this.#port(event.data.value);return}
      if(event.data.type==='guest-samples'){
        const {pid,samples,dropped,error}=event.data.value as GuestSamplingSnapshot&{pid:number}
        this.guestSamplesDropped+=dropped
        for(const sample of samples){
          this.guestSamples.push({...sample,pid})
          if(this.guestSamples.length>512){this.guestSamples.shift();this.guestSamplesOwnerDropped++}
        }
        if(error){
          this.guestSamplingErrors.push({pid,error})
          if(this.guestSamplingErrors.length>32)this.guestSamplingErrors.shift()
        }
        return
      }
      if(event.data.type==='host-task-scheduling'){
        this.hostTaskScheduling.push(event.data.value)
        if(this.hostTaskScheduling.length>32)this.hostTaskScheduling.shift()
        return
      }
      if(event.data.type==='worker-lifecycle'){
        this.workerLifecycle.push(event.data.value)
        if(this.workerLifecycle.length>256)this.workerLifecycle.shift()
        return
      }
      if(event.data.type==='job-profile'){
        if(event.data.value.phase==='live-scheduling'){
          this.schedulerDiagnostics.push(event.data.value)
          if(this.schedulerDiagnostics.length>64)this.schedulerDiagnostics.shift()
          return
        }
        if(event.data.value.phase==='worker-start-failure'){
          const row=event.data.value as WorkerStartFailure
          this.workerStartFailures.push({...row,workerStartError:{...row.workerStartError}})
          if(this.workerStartFailures.length>32){this.workerStartFailures.shift();this.#workerStartFailuresDropped++}
        }
        this.jobProfile.push(event.data.value)
        this.jobProfile.sort((a,b)=>b.ms-a.ms)
        if(this.jobProfile.length>100)this.jobProfile.length=100
        return
      }
      if(event.data.type==='heartbeat'){
        for(const call of this.#pending.values())call.renewHeartbeat?.()
        return
      }
      const {id,type,value,error,level,text}=event.data,call=this.#pending.get(id)
      if(!call)return
      if(type==='progress'){call.renewProgress?.();return}
      if(type==='output'){
        try{call.output?.(level,text)}catch(error){this.close(new Error('Output observer failed: '+String(error)))}
        return
      }
      clearTimeout(call.timer);clearTimeout(call.absoluteTimer);this.#pending.delete(id)
      error?call.reject(new Error(error)):call.resolve(value)
    }
    this.#worker.onerror=event=>this.close(new Error(event.message))
    this.#ready=this.#request('init',[files,this.#limits,workspace,limits.cooperative??false,this.assetBaseURL,limits.experimentalFibers??false,limits.experimentalFibers?sharedMemoryPerEngine:undefined,workerMaxBytes,experimentalCompiler,experimentalRolldownParser])
    // Release the owner on initialization failure, while retaining the rejected
    // ready promise so every public operation still reports that failure.
    void this.#ready.catch(error=>this.close(error))
  }
  #request(method:string,args:unknown[],output?:KernelOptions['onOutput']):Promise<any>{
    if(this.#closed)return Promise.reject(new Error('Kernel closed'))
    return new Promise((resolve,reject)=>{
      const id=++this.#next
      const deadlines=kernelRequestDeadlines(method,this.#limits.timeoutMs)
      const watchdog=()=>setTimeout(()=>this.close(new Error(`Kernel request timed out: ${method} (${deadlines.idleMs}ms inactive)`)),deadlines.idleMs)
      const absoluteTimer=deadlines.absoluteMs===undefined?undefined:setTimeout(()=>this.close(new Error(`Kernel request timed out: ${method} (${deadlines.absoluteMs}ms absolute)`)),deadlines.absoluteMs)
      const call={resolve,reject,output,timer:watchdog(),absoluteTimer,renewHeartbeat:undefined as (()=>void)|undefined,renewProgress:undefined as (()=>void)|undefined}
      const renew=()=>{clearTimeout(call.timer);call.timer=watchdog()}
      if(deadlines.progressRenewable)call.renewProgress=renew
      if(['processWait','processNext','processWrite','netRead','netWrite'].includes(method))call.renewHeartbeat=renew
      this.#pending.set(id,call)
      try{this.#worker.postMessage({id,method,args})}
      catch(error){clearTimeout(call.timer);clearTimeout(call.absoluteTimer);this.#pending.delete(id);reject(error)}
    })
  }
  async snapshot():Promise<WorkspaceSnapshot>{await this.#ready;return this.#request('snapshot',[])}
  async restore(snapshot:WorkspaceSnapshot){await this.#ready;await this.#request('restore',[snapshot])}
  /** Persists the current workspace without cloning its files through the owner thread. */
  async saveCheckpoint(key:string):Promise<CheckpointMetadata>{await this.#ready;return this.#request('saveCheckpoint',[key])}
  /** Replaces the workspace from a persisted checkpoint without cloning its files through the owner thread. */
  async restoreCheckpoint(key:string):Promise<CheckpointMetadata>{await this.#ready;return this.#request('restoreCheckpoint',[key])}
  async deleteCheckpoint(key:string):Promise<boolean>{await this.#ready;return this.#request('deleteCheckpoint',[key])}
  async checkpointMetadata(key:string):Promise<CheckpointMetadata|undefined>{await this.#ready;return this.#request('checkpointMetadata',[key])}
  async readFile(path:string):Promise<Uint8Array>{await this.#ready;return this.#request('readFile',[path])}
  async readText(path:string):Promise<string>{await this.#ready;return this.#request('readFile',[path,'utf8'])}
  async writeFile(path:string,data:Uint8Array){await this.#ready;await this.#request('writeFile',[path,data])}
  async writeText(path:string,text:string){await this.writeFile(path,new TextEncoder().encode(text))}
  async install(options:ProjectInstallOptions={},signal?:AbortSignal):Promise<ProjectInstallResult>{
    signal?.throwIfAborted()
    await this.#ready
    signal?.throwIfAborted()
    const installationToken=++this.#installationSequence
    const operation=this.#request('install',[options,installationToken])
    let cancellation:Promise<void>|undefined
    const abort=()=>{cancellation=this.#request('cancelInstall',[installationToken]).catch(error=>{this.close(error)})}
    signal?.addEventListener('abort',abort,{once:true})
    // Keep the operation pending until the worker has discarded the staged
    // installation. Otherwise the next mutation can race unfinished writes.
    try{
      const result=await operation
      // The worker may have committed before it receives cancellation. Report
      // that success rather than claiming an aborted install left files intact.
      return result
    }catch(error){signal?.throwIfAborted();throw error}
    finally{signal?.removeEventListener('abort',abort);await cancellation}
  }
  async cancelInstall(){await this.#ready;await this.#request('cancelInstall',[])}
  /** Read-only owner diagnostics for lifecycle checks and operational telemetry. */
  async resources():Promise<KernelResourceSnapshot>{await this.#ready;return this.#request('resources',[])}
  async openFileSession({writable=false}:{writable?:boolean}={}){
    await this.#ready
    const key:number=await this.#request('fileSessionOpen',[writable])
    let closed=false
    return {
      call:async(method:string,args:unknown[])=>{
        if(closed)throw Error('EBADF: file session closed')
        return this.#request('fileSessionCall',[key,method,args])
      },
      close:async()=>{
        if(closed)return
        closed=true
        await this.#request('fileSessionClose',[key])
      },
    }
  }
  #process(pid:number):KernelProcessHandle{
    let disposing:Promise<void>|undefined
    return {
      pid,
      next:():Promise<ProcessEvent|null>=>this.#request('processNext',[pid]),
      write:async(bytes:Uint8Array|string)=>{
        const data=typeof bytes==='string'?new TextEncoder().encode(bytes):bytes
        for(let offset=0;offset<data.length;offset+=16384)await this.#request('processWrite',[pid,data.slice(offset,offset+16384)])
      },
      end:()=>this.#request('processEnd',[pid]),
      wait:():Promise<KernelProcessResult>=>this.#request('processWait',[pid]),
      kill:(signal='SIGTERM'):Promise<boolean>=>this.#request('processKill',[pid,signal]),
      dispose:()=>disposing??=(async()=>{await this.#request('processKill',[pid,'SIGKILL']);await this.#request('processWait',[pid]);await this.#request('processForget',[pid])})(),
    }
  }
  async spawn(command:string,args:string[]=[],options:SpawnOptions={}):Promise<KernelProcessHandle>{
    await this.#ready
    const pid:number=await this.#request('spawn',[command,args,options])
    return this.#process(pid)
  }
  /** Start a long-lived shell command. Use runShell for bounded commands whose output should be collected. */
  async spawnShell(script:string,options:SpawnOptions={}):Promise<KernelProcessHandle>{
    await this.#ready
    const pid:number=await this.#request('spawnShell',[script,options])
    return this.#process(pid)
  }
  async connect(port:number,host='127.0.0.1'){
    await this.#ready
    const socket=await this.#request('netConnect',[port,host]) as {id:number;port:number;remotePort:number}
    return {
      port:socket.port,remotePort:socket.remotePort,
      read:():Promise<NetworkEvent|null>=>this.#request('netRead',[socket.id]),
      write:(bytes:Uint8Array)=>this.#request('netWrite',[socket.id,bytes]),
      end:()=>this.#request('netEnd',[socket.id]),
      close:()=>this.#request('netDestroy',[socket.id]),
    }
  }
  async execute(code:string,{onOutput,...options}:KernelOptions={}):Promise<KernelExecutionResult>{
    await this.#ready
    return this.#request('execute',[code,options],onOutput)
  }
  async run(entry:string,options:KernelOptions={}){
    const result=await compile(await this.snapshot(),entry,this.#abort.signal,{compact:true},this.assetBaseURL)
    return this.execute(result.code,options)
  }
  async runModule(entry:string,options:KernelOptions={}):Promise<KernelExecutionResult>{
    const {onOutput,...settings}=options
    await this.#ready
    return this.#request('execute',['',{...settings,entry}],onOutput)
  }
  close(error=new Error('Kernel closed')){
    if(this.#closed)return
    this.#closed=true;this.#abort.abort()
    const ports=this.listeningPorts
    this.#ports.clear()
    for(const port of ports)for(const listener of [...this.#portListeners]){
      if(this.#portListeners.has(listener))this.#notifyPort(listener,{type:'close',port})
    }
    this.#portListeners.clear()
    for(const call of this.#pending.values()){clearTimeout(call.timer);clearTimeout(call.absoluteTimer);call.reject(error)}
    this.#pending.clear()
    if(this.#parserShutdownMs===undefined){this.#worker.terminate();this.shutdown=Promise.resolve();return}
    this.shutdown=new Promise<void>((resolve,reject)=>{
      const id=++this.#next
      const finish=(error?:Error)=>{clearTimeout(timer);this.#pending.delete(id);if(error)this.#worker.terminate();error?reject(error):resolve()}
      const timer=setTimeout(()=>finish(Error('Native parser shutdown acknowledgement timed out')),this.#parserShutdownMs)
      this.#pending.set(id,{resolve:()=>finish(),reject:finish,timer})
      try{this.#worker.postMessage({id,method:'shutdown',args:[]})}catch(error){finish(Error(String(error)))}
    })
    // close() remains synchronous; owners may await shutdown for cleanup evidence.
    void this.shutdown.catch(()=>{})
  }
}
