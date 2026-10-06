import {WorkerHTTP} from '../sandbox/worker-http'
import {WorkerWebSocket} from '../sandbox/worker-websocket'
import {restoreKernelCheckpoint,saveKernelCheckpoint} from '../sandbox/checkpoint-storage'
import type {CheckpointMetadata} from '../sandbox/checkpoint-storage'
import type {WorkspaceSnapshot} from '../sandbox/files'
import type {NetworkEvent} from '../sandbox/virtual-network'
import type {RuntimeLock} from '../npm/types'
import {normalizePackageDownloadPolicy} from '../npm/download-policy'
import type {PackageDownloadPolicy} from '../npm/download-policy'
import type {TypeScriptDiagnostic} from './typescript-diagnostic'
import {parseNativeInstallCommand,parseNativeStartCommand,planNativeBuildScript} from './project-script'
import type {NativeTerminalResult,NativeTerminalOutput} from './terminal-types'
import type {ProjectInstallResult} from '../npm/project'
import {selectNativeRuntime} from './runtime-selection'
import type {NativeRuntimeCandidate} from './runtime-selection'
import {resolveRuntimeAssetBase} from '../sandbox/runtime-assets'
import {linkNativeFilesystemWorker} from './filesystem-worker-link.mjs'

type Pending={operation:string;resolve:(value:any)=>void;reject:(error:Error)=>void;timer?:ReturnType<typeof setTimeout>;onOutput?:NativeTerminalOutput}
export type NativeDevServerEvent=
  // Receiver-clock time since this dev server, or owner client, was created.
  // Worker-local clocks are not comparable across bootstrap and child workers.
  // durationMs, when present, is a completed span measured by its producer.
  |{type:'progress';phase:string;elapsedMs:number;durationMs?:number}
  |{type:'diagnostic';error:string;stack?:string}
  |{type:'output';stream:'stdout'|'stderr';text:string}
const nativeCheckpointKey=(key:string)=>{
  if(typeof key!=='string'||!key)throw Error('A checkpoint key is required')
  return `native-dev-server:${key}`
}

export interface NativeDevServerOptions{
  /** Same-origin URL of a hosted native worker bundle and its sibling assets. */
  workerURL:string|URL
  /** Experimental classic bootstrap, requires sibling classic-worker-bootstrap.js. */
  workerType?:WorkerType
  /** Same-origin directory containing workers/ and other runtime assets. Defaults to /runtime/. */
  assetBaseURL?:string
  /** Exact hosted toolchains to select using locked or mounted compiler versions. */
  runtimeCandidates?:readonly NativeRuntimeCandidate[]
  /** Root used by the host's file map. Files are mounted at /app in the worker. */
  workspaceRoot?:string
  /** Declared install request. Uses a mounted npm lockfile or resolves package.json in the browser. */
  installCommand?:string
  /** Package-manager command such as `pnpm run dev`; resolves a package.json script. */
  startCommand?:string
  lock?:RuntimeLock
  /** Use already mounted dependencies, for example when restoring a complete snapshot. */
  installDependencies?:boolean
  /** Host-approved extra HTTPS origins for locked package downloads. Registry-only by default. */
  packageDownloadPolicy?:PackageDownloadPolicy
  /** Direct workspace entry, exclusive with script. */
  entry?:string
  /** Serve a fetch export from entry over the virtual HTTP port. */
  serveFetchEntry?:boolean
  /** Optional workspace directory served before the fetch handler. */
  staticRoot?:string
  /** package.json script name. Direct `vite dev` and `node <entry>` commands are supported. */
  script?:string
  /** Environment variables visible to the project process. */
  env?:Record<string,string>
}

/** Owner-side transport for a Vite server running entirely in a browser worker. */
export class NativeDevServer {
  readonly worker:Worker
  readonly #filesystemOwner:Worker
  readonly ready:Promise<number>
  readonly diagnostics:Array<{error:string;stack?:string;diagnostic?:unknown}>=[]
  readonly progress:Array<{phase:string;elapsedMs:number}>=[]
  readonly events:NativeDevServerEvent[]=[]
  #eventListeners=new Set<(event:NativeDevServerEvent)=>void>()
  #pending=new Map<number,Pending>()
  #next=0
  #startedAt=performance.now()
  #closed=false
  #port=0
  #ownedPorts=new Set<number>()
  #webSocketToken=''
  #workspaceRevision=0
  #workspaceRoot:string
  #rejectReady?:(error:Error)=>void
  #bootstrapTimer?:ReturnType<typeof setTimeout>
  #startReconcileTimer?:ReturnType<typeof setTimeout>
  #startReconciling=false
  constructor(files:Record<string,string|Uint8Array>,options:NativeDevServerOptions,restoreSnapshot?:WorkspaceSnapshot){
    const packageDownloadPolicy=normalizePackageDownloadPolicy(options.packageDownloadPolicy)
    if(options.entry&&(options.script||options.startCommand))throw Error('Choose either a project script or an entry file')
    if(options.script&&options.startCommand)throw Error('Choose either script or startCommand')
    const root=options.workspaceRoot??'/app'
    if(!/^\/[A-Za-z0-9._-]+$/.test(root)||root==='/.'||root==='/..')throw Error('workspaceRoot must be a single absolute directory name')
    this.#workspaceRoot=root
    let startFiles:Record<string,string|Uint8Array>|undefined={}
    for(const [path,bytes] of Object.entries(files)){
      const target=this.#mountPath(path)
      if(Object.hasOwn(startFiles,target))throw Error(`Duplicate workspace file: ${path}`)
      startFiles[target]=bytes
    }
    if(options.installCommand){
      parseNativeInstallCommand(options.installCommand)
      if(options.installDependencies!==false&&!options.lock&&!Object.hasOwn(startFiles,'/app/package.json')&&
        !Object.hasOwn(restoreSnapshot?.files??{},'/app/package.json'))
        throw Error('Native project install requires package.json')
    }
    let startSnapshot=restoreSnapshot
    restoreSnapshot=undefined
    const script=options.startCommand?parseNativeStartCommand(options.startCommand):options.script
    const entry=options.entry?.startsWith('/')?this.#mountPath(options.entry):options.entry
    const staticRoot=options.staticRoot?this.#mountPath(options.staticRoot):undefined
    const selectedURL=options.runtimeCandidates
      ?selectNativeRuntime({...startSnapshot?.files,...startFiles},options.runtimeCandidates,options.lock,options.installDependencies===false).workerURL
      :options.workerURL
    const workerURL=new URL(selectedURL,location.href)
    if(workerURL.origin!==location.origin||!['http:','https:'].includes(workerURL.protocol))
      throw Error('Native worker URL must be on the application origin')
    const assetBaseURL=resolveRuntimeAssetBase(options.assetBaseURL??'/runtime/',location.href)
    const workerType=options.workerType??'module'
    const entryURL=workerType==='classic'?new URL('classic-worker-bootstrap.js',workerURL):workerURL
    entryURL.search=workerURL.search
    if(workerType==='classic')entryURL.searchParams.set('native-engine-path',workerURL.pathname)
    this.#filesystemOwner=new Worker(new URL('filesystem-owner.mjs',workerURL),{type:'module'})
    try{
      this.worker=new Worker(entryURL,{type:workerType})
      linkNativeFilesystemWorker(this.worker,{control:this.#filesystemOwner,id:'runtime'})
    }catch(error){this.#filesystemOwner.terminate();throw error}
    this.worker.onmessage=({data})=>{
      if(data.type==='native-dev-fatal'){
        this.diagnostics.push({error:data.error,stack:data.stack,diagnostic:data.diagnostic})
        const error=Object.assign(new Error(data.error),{diagnostic:data.diagnostic})
        if(typeof data.stack==='string')error.stack=data.stack
        this.close(error)
        return
      }
      if(data.type==='native-dev-diagnostic'){
        this.diagnostics.push({error:data.error,stack:data.stack,diagnostic:data.diagnostic})
        this.#emit({type:'diagnostic',error:data.error,stack:data.stack})
        return
      }
      if(data.type==='native-dev-progress'){
        this.#recordProgress(data.phase)
        if(data.phase==='start-response-posted')this.#scheduleStartReconcile(250)
        return
      }
      if(data.type==='native-dev-output'){
        this.#emit({type:'output',stream:data.stream,text:data.text})
        return
      }
      if(data.type==='native-terminal-output'){
        const callback=this.#pending.get(data.id)?.onOutput
        if(callback){try{callback(data.text,data.stream)}catch{/* Terminal observers cannot affect the command. */}}
        return
      }
      if(data.type==='native-dev-ready'){
        clearTimeout(this.#bootstrapTimer)
        const mounted=startFiles,snapshot=startSnapshot
        startFiles=undefined
        startSnapshot=undefined
        if(!mounted){this.close(Error('Native dev worker requested startup twice'));return}
        const transfer=snapshot?[...new Set(Object.values(snapshot.files).map(bytes=>bytes.buffer).filter((buffer):buffer is ArrayBuffer=>buffer instanceof ArrayBuffer))]:[]
        this.#call<{port:number;webSocketToken:string}>('start',{files:mounted,restoreSnapshot:snapshot,lock:options.lock,installDependencies:options.installDependencies!==false,installRequested:!!options.installCommand,packageDownloadPolicy,entry,script,env:options.env,serveFetchEntry:options.serveFetchEntry,staticRoot,assetBaseURL},180000,true,transfer)
          .then(({port,webSocketToken})=>{
            clearTimeout(this.#startReconcileTimer)
            this.#port=port
            this.#webSocketToken=webSocketToken
            this.#rejectReady=undefined
            resolveReady(port)
          },error=>this.close(error))
        this.#scheduleStartReconcile(5000)
        return
      }
      const pending=this.#pending.get(data.id)
      if(pending?.operation==='start'||data.id===1&&data.type===undefined){
        const event={type:'progress' as const,phase:pending?'host-start-response-received':'host-start-response-orphaned',
          elapsedMs:Math.round(performance.now()-this.#startedAt)}
        this.progress.push(event)
        this.#emit(event)
      }
      if(!pending)return
      this.#pending.delete(data.id)
      clearTimeout(pending.timer)
      if(pending.operation==='start')clearTimeout(this.#startReconcileTimer)
      if(data.ok)pending.resolve(data.value)
      else{
        const error=new Error(data.error)
        if(typeof data.stack==='string')error.stack=data.stack
        pending.reject(error)
      }
    }
    this.worker.onerror=event=>this.close(new Error(event.error?.stack??`${event.message} at ${event.filename}:${event.lineno}:${event.colno}`))
    this.#filesystemOwner.onerror=event=>this.close(new Error(`Filesystem worker failed: ${event.message}`))
    this.#filesystemOwner.onmessageerror=()=>this.close(Error('Filesystem worker message could not be decoded'))
    this.worker.onmessageerror=()=>this.close(Error('Native dev worker message could not be decoded'))
    let resolveReady!:(port:number)=>void,rejectReady!:(error:Error)=>void
    this.ready=new Promise<number>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject})
    this.#rejectReady=rejectReady
    this.#bootstrapTimer=setTimeout(()=>this.close(Error('Native dev worker bootstrap timed out')),30000)
  }
  #mountPath(path:string){
    if(path!==this.#workspaceRoot&&!path.startsWith(this.#workspaceRoot+'/'))throw Error(`Path must be inside ${this.#workspaceRoot}: ${path}`)
    if(path.split('/').some((part,index)=>index>0&&(!part||part==='.'||part==='..'))||path.includes('\\')||path.includes('\0'))throw Error(`Invalid workspace path: ${path}`)
    return '/app'+path.slice(this.#workspaceRoot.length)
  }
  #hostPath(path:string){
    if(path!=='/app'&&!path.startsWith('/app/'))throw Error(`Worker returned a path outside the workspace: ${path}`)
    return this.#workspaceRoot+path.slice('/app'.length)
  }
  #terminalPath(path:string,direction:'mount'|'host'){
    if(path==='/tmp'||path.startsWith('/tmp/')){
      if(path.split('/').some((part,index)=>index>0&&(!part||part==='.'||part==='..'))||path.includes('\\')||path.includes('\0'))throw Error('Invalid scratch directory')
      return path
    }
    return direction==='mount'?this.#mountPath(path):this.#hostPath(path)
  }
  #emit(event:NativeDevServerEvent){
    this.events.push(event.type==='output'&&event.text.length>8192?{...event,text:event.text.slice(-8192)}:event)
    if(this.events.length>256)this.events.shift()
    for(const listener of this.#eventListeners)try{listener(event)}catch{/* Observers cannot affect the project. */}
  }
  #recordProgress(phase:string,durationMs?:number){
    const elapsedMs=Math.round(performance.now()-this.#startedAt)
    this.progress.push({phase,elapsedMs})
    this.#emit({type:'progress',phase,elapsedMs,...(durationMs===undefined?{}:{durationMs})})
  }
  /** Subscribe to live process output, startup progress, and diagnostics. */
  subscribeEvents(listener:(event:NativeDevServerEvent)=>void){
    this.#eventListeners.add(listener)
    return ()=>{this.#eventListeners.delete(listener)}
  }
  #scheduleStartReconcile(delayMs:number){
    if(this.#closed||![...this.#pending.values()].some(pending=>pending.operation==='start'))return
    clearTimeout(this.#startReconcileTimer)
    this.#startReconcileTimer=setTimeout(()=>{void this.#reconcileStart()},delayMs)
  }
  async #reconcileStart(){
    if(this.#closed||this.#startReconciling)return
    const start=[...this.#pending.entries()].find(([,pending])=>pending.operation==='start')
    if(!start)return
    this.#startReconciling=true
    try{
      const result=await this.#call<
        {state:'pending'}|{state:'ready';value:{port:number;webSocketToken:string}}|{state:'failed';error:string}
      >('startStatus',{},10000,false)
      const pending=this.#pending.get(start[0])
      if(!pending)return
      if(result.state==='pending')return
      this.#pending.delete(start[0])
      clearTimeout(pending.timer)
      const event={type:'progress' as const,phase:'start-result-reconciled',
        elapsedMs:Math.round(performance.now()-this.#startedAt)}
      this.progress.push(event)
      this.#emit(event)
      result.state==='ready'?pending.resolve(result.value):pending.reject(Error(result.error))
    }catch{/* The original start deadline remains authoritative. */}
    finally{
      this.#startReconciling=false
      this.#scheduleStartReconcile(5000)
    }
  }
  #call<T>(operation:string,fields:Record<string,unknown>={},timeoutMs=30000,fatalOnTimeout=true,transfer:Transferable[]=[],onOutput?:NativeTerminalOutput,signal?:AbortSignal):Promise<T>{
    if(this.#closed)return Promise.reject(Error('Native dev server closed'))
    if(signal?.aborted)return Promise.reject(Object.assign(Error('Terminal command interrupted'),{name:'AbortError'}))
    let abort:()=>void=()=>{}
    return new Promise<T>((resolve,reject)=>{
      const id=++this.#next
      abort=()=>{
        try{this.worker.postMessage({id:0,operation:'cancelTerminal',commandId:id})}
        catch(error){this.close(error instanceof Error?error:Error(String(error)))}
      }
      signal?.addEventListener('abort',abort,{once:true})
      const timer=timeoutMs?setTimeout(()=>{
        const error=Error(`Native dev server ${operation} timed out`)
        if(fatalOnTimeout)this.close(error)
        else{this.#pending.delete(id);reject(error)}
      },timeoutMs):undefined
      this.#pending.set(id,{operation,resolve,reject,timer,onOutput})
      try{this.worker.postMessage({id,operation,...fields},transfer)}
      catch(error){clearTimeout(timer);this.#pending.delete(id);reject(error)}
    }).finally(()=>signal?.removeEventListener('abort',abort))
  }
  async connect(port:number){
    await this.ready
    if(port!==this.#port&&!this.#ownedPorts.has(port))throw Error('Port is not owned by this dev server')
    const result=await this.#call<{socketId:number;port:number;remotePort:number}>('connect',{port})
    const {socketId}=result
    return {
      port:result.port,remotePort:result.remotePort,
      read:()=>this.#call<NetworkEvent|null>('read',{socketId},0),
      write:(bytes:Uint8Array)=>this.#call<void>('write',{socketId,bytes}),
      end:()=>this.#call<void>('end',{socketId}),
      close:()=>this.#call<void>('closeSocket',{socketId}),
    }
  }
  async fetch(request:Request){
    const port=await this.#portFor(request.url)
    return new WorkerHTTP(this,port).fetch(request)
  }
  async #portFor(url:string){
    const readyPort=await this.ready
    const requested=Number(new URL(url).port)
    if(requested&&(requested===readyPort||this.#ownedPorts.has(requested)||
      (await this.ports()).includes(requested)))return requested
    if(readyPort)return readyPort
    throw Error('URL must name a listening project port')
  }
  previewServer(port:number){
    if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid project preview port')
    return {fetch:(request:Request)=>new WorkerHTTP(this,port).fetch(request),
      revision:()=>this.#workspaceRevision}
  }
  workspaceRevision(){return this.#workspaceRevision}
  async ports(){
    await this.ready
    const ports=await this.#call<number[]>('ports')
    this.#ownedPorts=new Set(ports)
    return ports
  }
  /** Wait until a listening project service can answer HTTP requests. */
  async waitForHTTPReady(options:{port?:number;path?:string;timeoutMs?:number}={}){
    const readyPort=await this.ready
    const path=options.path??'/'
    const timeoutMs=options.timeoutMs??30000
    if(options.port!==undefined&&(!Number.isInteger(options.port)||options.port<1||options.port>65535))
      throw Error('Invalid project HTTP port')
    if(!path.startsWith('/')||path.startsWith('//'))throw Error('HTTP readiness path must start with one slash')
    if(!Number.isFinite(timeoutMs)||timeoutMs<=0)throw Error('HTTP readiness timeout must be positive')
    const deadline=performance.now()+timeoutMs
    const readinessStarted=deadline-timeoutMs
    this.#recordProgress('http-readiness-started')
    let lastError:unknown
    while(performance.now()<deadline){
      if(this.#closed)throw Error('Native dev server closed')
      try{
        const owned=await this.ports()
        const candidates=options.port!==undefined?[options.port]:
          readyPort>0?[readyPort]:
            [...new Set(owned.filter(port=>Number.isInteger(port)&&port>0&&port<=65535))]
        if(!candidates.length)lastError=Error('Project has not opened an HTTP port')
        for(const port of candidates){
          if(port!==readyPort&&!owned.includes(port)){
            lastError=Error(`Project has not opened port ${port}`)
            continue
          }
          try{
            this.#recordProgress('http-readiness-probe-started')
            const response=await this.previewServer(port).fetch(new Request(`http://127.0.0.1:${port}${path}`,{
              headers:{Accept:'text/html'},signal:AbortSignal.timeout(Math.max(1,Math.min(5000,deadline-performance.now()))),
            }))
            this.#recordProgress('http-readiness-headers-received')
            await response.body?.cancel()
            if(response.status<500){
              this.#recordProgress('http-readiness-completed',Math.round(performance.now()-readinessStarted))
              return port
            }
            lastError=Error(`HTTP status ${response.status} on port ${port}`)
            this.#recordProgress('http-readiness-probe-failed')
          }catch(error){lastError=error;this.#recordProgress('http-readiness-probe-failed')}
        }
      }catch(error){lastError=error}
      await new Promise(resolve=>setTimeout(resolve,Math.min(250,Math.max(0,deadline-performance.now()))))
    }
    throw Error(`Project HTTP readiness timed out${options.port?` on port ${options.port}`:''}: ${String(lastError??'no response')}`)
  }
  async writeFile(path:string,bytes:string|Uint8Array){
    await this.ready
    await this.#call<void>('writeFile',{path:this.#mountPath(path),bytes})
    this.#workspaceRevision++
  }
  async readFile(path:string){
    await this.ready
    return this.#call<Uint8Array>('readFile',{path:this.#mountPath(path)})
  }
  async mkdir(path:string,options:{recursive?:boolean;mode?:number}={}){
    await this.ready
    const created=await this.#call<boolean>('mkdir',{path:this.#mountPath(path),options})
    if(created)this.#workspaceRevision++
  }
  async installResult(){await this.ready;return this.#call<ProjectInstallResult>('installResult',{})}
  async listDirectory(path:string){
    await this.ready
    return this.#call<Array<{name:string,type:'file'|'directory'|'symlink'}>>('listDirectory',{path:this.#mountPath(path)})
  }
  async rename(from:string,to:string){
    await this.ready
    const changed=await this.#call<boolean>('rename',{from:this.#mountPath(from),to:this.#mountPath(to)})
    if(changed)this.#workspaceRevision++
  }
  async remove(path:string,options:{recursive?:boolean;force?:boolean}={}){
    await this.ready
    const changed=await this.#call<boolean>('remove',{path:this.#mountPath(path),options})
    if(changed)this.#workspaceRevision++
  }
  async listTerminalCommands(){
    await this.ready
    return this.#call<string[]>('listTerminalCommands')
  }
  async terminalCommand(line:string,cwd=this.#workspaceRoot,onOutput?:NativeTerminalOutput,signal?:AbortSignal,inputPort?:MessagePort,shellState?:string,
    size?:{columns:number;rows:number}):Promise<NativeTerminalResult>{
    await this.ready
    if(signal?.aborted){inputPort?.close();return {cwd,stdout:'',stderr:'',exitCode:130,changedPaths:[]}}
    const workerCwd=this.#terminalPath(cwd,'mount')
    let result:NativeTerminalResult
    try{result=await this.#call<NativeTerminalResult>('terminalCommand',{line,cwd:workerCwd,streamOutput:!!onOutput,inputPort,shellState,size},0,true,
      inputPort?[inputPort]:[],onOutput,signal)}
    catch(error){
      if(signal?.aborted)return {cwd,stdout:'',stderr:'',exitCode:130,changedPaths:[]}
      throw error
    }
    if(result.changedPaths.length)this.#workspaceRevision++
    return {...result,cwd:this.#terminalPath(result.cwd,'host'),
      changedPaths:result.changedPaths.map(path=>this.#hostPath(path)),
      stdout:result.stdout}
  }
  /** Open one live shell whose interpreter state survives separate prompt commands. */
  async openTerminalSession(cwd=this.#workspaceRoot){
    await this.ready
    const sessionId=await this.#call<number>('terminalSessionOpen',{cwd:this.#terminalPath(cwd,'mount')},30000)
    let closed=false
    let currentCwd=cwd
    return {
      runCommand:async(line:string,onOutput?:NativeTerminalOutput,signal?:AbortSignal,inputPort?:MessagePort,
        size?:{columns:number;rows:number}):Promise<NativeTerminalResult>=>{
        if(closed){inputPort?.close();throw Error('Terminal session closed')}
        if(signal?.aborted){inputPort?.close();return {cwd:currentCwd,stdout:'',stderr:'',exitCode:130,changedPaths:[]}}
        const result=await this.#call<NativeTerminalResult>('terminalSessionRun',
          {sessionId,line,streamOutput:!!onOutput,inputPort,size},0,true,inputPort?[inputPort]:[],onOutput,signal)
        if(result.changedPaths.length)this.#workspaceRevision++
        currentCwd=this.#terminalPath(result.cwd,'host')
        return {...result,cwd:currentCwd,changedPaths:result.changedPaths.map(path=>this.#hostPath(path))}
      },
      dispose:async()=>{
        if(closed)return
        closed=true
        if(!this.#closed)await this.#call<void>('terminalSessionClose',{sessionId},30000)
      },
    }
  }
  async snapshot(){
    await this.ready
    const files=await this.#call<Record<string,Uint8Array>>('snapshot',{},90000)
    return Object.fromEntries(Object.entries(files).map(([path,bytes])=>[this.#hostPath(path),bytes]))
  }
  /** Inspect the complete workspace shape using host-visible paths. */
  async snapshotWorkspace():Promise<Extract<WorkspaceSnapshot,{version:5}>>{
    await this.ready
    const snapshot=await this.#call<Extract<WorkspaceSnapshot,{version:5}>>('snapshotWorkspace',{},90000)
    const paths=<T>(entries:Record<string,T>)=>Object.fromEntries(Object.entries(entries).map(([path,value])=>[this.#hostPath(path),value]))
    return {
      version:5,
      files:paths(snapshot.files),
      directories:snapshot.directories.map(path=>this.#hostPath(path)),
      symlinks:paths(Object.fromEntries(Object.entries(snapshot.symlinks).map(([path,target])=>[
        path,target==='/app'||target.startsWith('/app/')?this.#hostPath(target):target,
      ]))),
      fileModes:paths(snapshot.fileModes),
      directoryModes:paths(snapshot.directoryModes),
      ...(snapshot.fileTimes?{fileTimes:paths(snapshot.fileTimes)}:{}),
      ...(snapshot.directoryTimes?{directoryTimes:paths(snapshot.directoryTimes)}:{}),
    }
  }
  /** Replace the running workspace, keeping this worker alive if replacement startup fails. */
  async restoreWorkspace(snapshot:Extract<WorkspaceSnapshot,{version:5}>,options:NativeDevServerOptions,
    validate?:(replacement:NativeDevServer)=>Promise<void>):Promise<NativeDevServer>{
    await this.ready
    if(snapshot.version!==5)throw TypeError('Native workspace restore requires snapshot version 5')
    if((options.workspaceRoot??'/app')!==this.#workspaceRoot)throw Error('Restore workspace root must match the current workspace')
    const copy=structuredClone(snapshot)
    const paths=<T>(entries:Record<string,T>)=>Object.fromEntries(Object.entries(entries).map(([path,value])=>[this.#mountPath(path),value]))
    const mounted:Extract<WorkspaceSnapshot,{version:5}>={
      version:5,files:paths(copy.files),directories:copy.directories.map(path=>this.#mountPath(path)),
      symlinks:paths(Object.fromEntries(Object.entries(copy.symlinks).map(([path,target])=>[
        path,target===this.#workspaceRoot||target.startsWith(this.#workspaceRoot+'/')?this.#mountPath(target):target,
      ]))),fileModes:paths(copy.fileModes),directoryModes:paths(copy.directoryModes),
      ...(copy.fileTimes?{fileTimes:paths(copy.fileTimes)}:{}),
      ...(copy.directoryTimes?{directoryTimes:paths(copy.directoryTimes)}:{}),
    }
    const replacement=new NativeDevServer({},{...options,lock:undefined,installDependencies:false},mounted)
    try{await replacement.ready;await validate?.(replacement)}
    catch(error){replacement.close();throw error}
    try{await this.dispose()}catch{this.close()}
    return replacement
  }
  /** Persist files, directories, symlinks, and permission modes in the browser. */
  async saveCheckpoint(key:string):Promise<CheckpointMetadata>{
    await this.ready
    const snapshot=await this.#call<WorkspaceSnapshot>('snapshotWorkspace',{},90000)
    const metadata=await saveKernelCheckpoint(nativeCheckpointKey(key),snapshot)
    return {...metadata,key}
  }
  /** Start a new worker from a previously saved native workspace. */
  static async restoreCheckpoint(key:string,options:NativeDevServerOptions){
    const {snapshot}=await restoreKernelCheckpoint(nativeCheckpointKey(key))
    if(snapshot.version===1)return new NativeDevServer(snapshot.files,{...options,lock:undefined,installDependencies:false})
    return new NativeDevServer({},{...options,lock:undefined,installDependencies:false},snapshot)
  }
  /** Replace the worker while preserving the complete mounted workspace. */
  async restart(options:NativeDevServerOptions):Promise<NativeDevServer>{
    await this.ready
    const snapshot=await this.#call<WorkspaceSnapshot>('snapshotWorkspace',{},90000)
    await this.dispose()
    return new NativeDevServer({},{...options,lock:undefined,installDependencies:false},snapshot)
  }
  /** Install from the current workspace in a replacement worker. Keep this server alive if startup fails. */
  async reinstall(options:NativeDevServerOptions,onEvent?:(event:NativeDevServerEvent)=>void,signal?:AbortSignal,
    validate?:(replacement:NativeDevServer)=>Promise<void>):Promise<NativeDevServer>{
    await this.ready
    signal?.throwIfAborted()
    const snapshot=await this.#call<WorkspaceSnapshot>('snapshotWorkspace',{},90000)
    signal?.throwIfAborted()
    const replacement=new NativeDevServer({},{...options,lock:undefined,installDependencies:true,
      installCommand:options.installCommand??'npm install'},snapshot)
    const unsubscribe=onEvent?replacement.subscribeEvents(onEvent):undefined
    const abort=()=>replacement.close(Object.assign(Error('Install interrupted'),{name:'AbortError'}))
    signal?.addEventListener('abort',abort,{once:true})
    try{await replacement.ready;await validate?.(replacement);signal?.throwIfAborted()}
    catch(error){replacement.close();throw error}
    finally{unsubscribe?.();signal?.removeEventListener('abort',abort)}
    try{await this.dispose()}catch{this.close()}
    return replacement
  }
  async build(options:{ssr?:boolean}={}){
    await this.ready
    const files=await this.#call<string[]>('build',{ssr:options.ssr===true},180000)
    return files.map(path=>this.#hostPath(path))
  }
  async typecheck(){
    await this.ready
    return this.#call<{diagnostics:TypeScriptDiagnostic[]}>('typecheck',{},180000)
  }
  async runBuildScript(name='build',onStep?:(text:string)=>void){
    const manifest=new TextDecoder().decode(await this.readFile(this.#workspaceRoot+'/package.json'))
    const steps=planNativeBuildScript(manifest,name)
    const outputFiles:string[]=[]
    for(const step of steps){
      if(step.kind==='vite-build'){
        onStep?.(`vite build${step.ssr?' --ssr':''}\n`)
        const built=await this.build({ssr:step.ssr})
        outputFiles.push(...built)
        onStep?.(`Built ${built.length} files\n`)
      }
      else{
        onStep?.('tsc --noEmit\n')
        const result=await this.typecheck()
        if(result.diagnostics.some(diagnostic=>diagnostic.category===1)){
          const error=Object.assign(Error(`TypeScript check failed with ${result.diagnostics.length} diagnostic(s)`),result)
          throw error
        }
        onStep?.('Typecheck passed\n')
      }
    }
    return {steps,outputFiles}
  }
  async connectWebSocket(origin:string,url:string,protocols:string[]=[]){
    const port=await this.#portFor(url)
    return WorkerWebSocket.connect(this,port,origin,url,protocols)
  }
  async previewWebSocket(port:number,origin:string,url:string,protocols:string[]=[]){
    if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid project preview port')
    await this.ready
    return WorkerWebSocket.connect(this,port,origin,url,protocols)
  }
  async hmrURL(){
    const port=await this.ready
    return `ws://127.0.0.1:${port}/?token=${encodeURIComponent(this.#webSocketToken)}`
  }
  /** Close guest services before terminating the worker. */
  async dispose(){
    if(this.#closed)return
    try{await this.#call<void>('close',{},30000)}
    finally{this.close()}
  }
  close(reason=new Error('Native dev server closed')){
    if(this.#closed)return
    this.#closed=true
    clearTimeout(this.#bootstrapTimer)
    clearTimeout(this.#startReconcileTimer)
    this.worker.terminate()
    this.#filesystemOwner.terminate()
    this.#rejectReady?.(reason)
    this.#rejectReady=undefined
    for(const pending of this.#pending.values()){
      clearTimeout(pending.timer)
      pending.reject(reason)
    }
    this.#pending.clear()
    this.#eventListeners.clear()
  }
}
