import {newQuickJSWASMModuleFromVariant,newVariant,type QuickJSDeferredPromise,type QuickJSAsyncContext} from 'quickjs-emscripten-core'
import SYNC from '@jitl/quickjs-wasmfile-release-sync'
import alsBootstrap from './engine-als-bootstrap.js?raw'
import {formatGuestConsoleError} from './guest-console-error.js'
import taskQueueBootstrap from './guest-task-queue.js?raw'
import {WorkspaceFiles} from './files'
import {dataModuleSource} from './data-module'
import {fileCallSync} from './file-capability'
import {processDirectory,processPath,processFileArguments,watchEventFilename} from './process-directory'
import {resolveProcessEntry} from './process-entry'
import {FileDescriptors} from './file-descriptors'
import {WorkspaceFileSessions} from './workspace-file-sessions'
import {IntlDateTimeBackend} from './intl-backend'
import intlBootstrap from './guest-intl.js?raw'
import {ModuleResolver} from './module-resolver'
import {createModuleSourceBudget} from './module-source-budget'
import moduleBootstrap from './module-bootstrap.js?raw'
import moduleHooks from './guest-module-hooks.js?raw'
import wasmBootstrap from './guest-wasm.js?raw'
import workspaceFetchBootstrap from './guest-workspace-fetch.js?raw'
import {createWorkspaceAssetReader} from './workspace-assets'
import {initSync as initializeCJSParser,parse as parseCJS} from 'cjs-module-lexer'
import {TaskScheduler} from './task-scheduler'
import {createLiveSchedulingDiagnostics,createFiberPhaseTiming,type FiberDiagnosticPhase} from './live-scheduling-diagnostics'
import {createGuestSamplingReader,createGuestSamplingBoundaries,type GuestSamplingModule} from './guest-sampling'
import {EngineAccess,type CompletionSource} from './engine-access'
import {WorkerMessageTiming} from './worker-message-timing'
import {WorkerPoll} from './worker-poll'
import {initializeTrustedWebAPIs} from './trusted-initializer'
import {compileTrustedProcessBuiltin,compileTrustedInspectionInitializer} from './trusted-builtin'
import {createCooperativeEngine} from './cooperative-engine'
import {getFiberEngine,runKernelFiber,type FiberContext} from './fiber-engine'
import {SharedMessageSender,sharedDelivery,type SharedContext} from './shared-message'
import {ModuleMessageBudget,ModuleMessageSender,moduleDelivery} from './module-message'
import {retainModuleSource} from './module-source'
import {createWasmModuleTiming} from './wasm-module-timing'
import type {MessageResource} from './process-message-queue'
import {withStartupDeadline} from './startup-deadline'
import {ExecutionBudget,processLifetime} from './execution-budget'
import {kernelLimits,executionLimits,childExecutionLimits,workspaceLimits,sharedMemoryPerEngineLimits,workerMemoryLimit,workerExecutionLimits,type KernelLimits,type KernelWorkspaceLimits,type KernelSharedMemoryPerEngineLimits} from './kernel-limits'
import {installProject,type PackageLifecycleTask,type ProjectInstallOptions} from '../npm/project'
import {VirtualNetwork,networkCall} from './virtual-network'
import {VirtualDatagramNetwork,datagramCall} from './virtual-datagram-network'
import {TLSBackend,loadTLSFactory,type TLSSettings} from './tls-backend'
import {HTTP2Backend,loadHTTP2Factory} from './http2-backend'
import {GuestProcesses,processStdio,type ManagedProcess,type ProcessInput,type SpawnOptions} from './guest-processes'
import {resolveRuntimeAssetBase,runtimeAssetURL} from './runtime-assets'
import {runMvdanWorker} from './mvdan-worker'
import {compilerPolicy} from '../compiler/compiler-policy'
import {prepareEsbuildArtifact} from '../compiler/esbuild-artifact'
import {CompilerWorkspace} from '../compiler/compiler-workspace'
import {runBrowserCompiler} from '../compiler/browser-compiler-runner'
import {createBrowserCompilerWorker} from './worker-factories'
import {NativeRolldownParser,type NativeParserOptions} from '../compiler/rolldown-parser'
import {rolldownParserPolicy,rolldownParserResources,rolldownSynchronousCompilerResources} from '../compiler/rolldown-parser-policy'
import {completeKernelWorkerRequest,shutdownKernelResources} from './kernel-worker-lifecycle'
import {prepareRolldownBindingArtifact} from '../compiler/rolldown-binding-artifact'
import {createGuestCallableDispatch} from '../compiler/guest-callable-dispatch'
import {createGuestParserAdapter} from '../compiler/guest-parser-adapter'
import {createGuestCallableAdapter} from '../compiler/guest-callable-adapter'
import {createRolldownGuestBinding} from '../compiler/rolldown-guest-binding'
import {callableLimits} from '../compiler/rolldown-callable-protocol'
import {createGuestBundlerAdapter} from '../compiler/guest-bundler-adapter'
import {restoreGuestBindingResult} from '../compiler/rolldown-binding-output'
import {createKernelBundlerHost,dispatchKernelBundlerCallback,type KernelBundlerSnapshot} from '../compiler/kernel-bundler-host'
import {deleteKernelCheckpoint,kernelCheckpointMetadata,restoreKernelCheckpoint,saveKernelCheckpoint} from './checkpoint-storage'

// This trusted worker is the filesystem owner. Guest code runs only in QuickJS.
// No file RPC, stack suspension, browser promises, or browser objects enter it.
let files:WorkspaceFiles|undefined
let descriptors:FileDescriptors|undefined
let fileSessions:WorkspaceFileSessions|undefined
let nextFileSession=0
const fileSessionLeases=new Map<number,ReturnType<WorkspaceFileSessions['open']>>()
let active=false
const activeHostTaskTraces=new Map<number,{pid:number;count:number;dropped:number;hostTasks:import('./task-scheduler').TaskSchedulerSample[]}>()
let installation:AbortController|undefined
let installationToken:unknown
let limits=kernelLimits()
let workerMaxBytes:number|undefined
let experimentalCompiler:ReturnType<typeof compilerPolicy>
let experimentalRolldownParser:ReturnType<typeof rolldownParserPolicy>
let nativeParser:Promise<NativeRolldownParser>|undefined
let synchronousCompiler:Promise<NativeRolldownParser>|undefined
let nativeParserState:'idle'|'opening'|'active'|'closing'|'closed'|'failed'='idle'
let nativeParserCalls=0
let nativeParserCompletedCalls=0
let nativeParserFailedCalls=0
let nativeParserPendingSourceBytes=0
let nativeParserInstance:NativeRolldownParser|undefined
let synchronousCompilerInstance:NativeRolldownParser|undefined
const nativeCallableRoutes=new Map<number,(method:string,args:unknown[])=>Promise<unknown>>()
let nativeCallableQueue:Promise<void>=Promise.resolve()
let nativeCallablePendingBytes=0
let nativeCallableCompleted=0,nativeCallableFailed=0,nativeCallableHandles=0
const nativeBundlerSnapshots=new Map<number,()=>KernelBundlerSnapshot>()
const retiredBundlerSnapshots:Array<{pid:number;state:KernelBundlerSnapshot}>=[]
let shuttingDown=false
function getNativeParser(){
  if(shuttingDown)throw Error('Kernel is shutting down')
  if(!experimentalRolldownParser)throw Error('Native parser is disabled')
  if(!nativeParser){
    nativeParserState='opening'
    nativeParser=NativeRolldownParser.open({
      createWorker:()=>new Worker(runtimeAssetURL('rolldown-parser/worker.js',assetBaseURL),{type:'module'}),
      wasmURL:runtimeAssetURL('rolldown-parser/parser.wasm',assetBaseURL).href,
      pthreadURL:runtimeAssetURL('rolldown-parser/pthread.js',assetBaseURL).href,
      policy:experimentalRolldownParser,
      resolver:{snapshot:files!.snapshot(),maxBytes:Math.min(files!.maxBytes,callableLimits.maxWorkspaceBytes),maxFiles:Math.min(files!.maxFiles,callableLimits.maxWorkspaceFiles),callback(handle,method,args){
        const route=nativeCallableRoutes.get(handle)
        if(!route)return Promise.reject(Error('Native callable owner is unavailable'))
        return route(method,args)
      },bundlerCallback:dispatchKernelBundlerCallback},
    }).then(parser=>{nativeParserInstance=parser;nativeParserState=shuttingDown?'closing':'active';return parser},error=>{nativeParserState='failed';throw error})
  }
  return nativeParser
}
function getSynchronousCompiler(){
  if(shuttingDown)throw Error('Kernel is shutting down')
  if(!experimentalRolldownParser)throw Error('Native parser is disabled')
  if(!synchronousCompiler)synchronousCompiler=NativeRolldownParser.open({
    createWorker:()=>new Worker(runtimeAssetURL('rolldown-parser/worker.js',assetBaseURL),{type:'module'}),
    wasmURL:runtimeAssetURL('rolldown-parser/parser.wasm',assetBaseURL).href,
    pthreadURL:runtimeAssetURL('rolldown-parser/pthread.js',assetBaseURL).href,
    policy:experimentalRolldownParser,
    profile:'sync',
  }).then(parser=>{synchronousCompilerInstance=parser;return parser},error=>{nativeParserState='failed';throw error})
  return synchronousCompiler
}
let cooperative=false
let experimentalFibers=false
const moduleMessageBudget=new ModuleMessageBudget(64*1024*1024)
let sharedMemoryPerEngine=sharedMemoryPerEngineLimits()
let assetBaseURL:string|undefined
const network=new VirtualNetwork()
network.subscribePorts(value=>self.postMessage({type:'port',value}))
const datagrams=new VirtualDatagramNetwork()
let tlsBackendPromise:Promise<TLSBackend>|undefined
const getTLSBackend=()=>tlsBackendPromise??=(loadTLSFactory(assetBaseURL).then(factory=>new TLSBackend(factory,4,factory)))
let http2BackendPromise:Promise<HTTP2Backend>|undefined
const getHTTP2Backend=()=>http2BackendPromise??=(loadHTTP2Factory(assetBaseURL).then(factory=>new HTTP2Backend(factory,4,factory)))
const processes=new GuestProcesses(record=>record.input.kind==='shell'
  ?executeShell(record)
  :executeManagedJavaScript(record))
const enginePromises=new Map<boolean,ReturnType<typeof newQuickJSWASMModuleFromVariant>>()
let webSource:Promise<string>|undefined
type BuiltinArtifact={version:number;modules:Record<string,{cjs:string;exports:string[]}>;assets?:Record<string,{path:string}>;preparations?:Array<{name:string;requiresGuestWasm?:boolean;source:string}>;inspection:string}
let moduleArtifact:Promise<BuiltinArtifact>|undefined
const getEngine=(guestWasm=false)=>{
  let promise=enginePromises.get(guestWasm)
  if(promise)return promise
  const path=guestWasm?'quickjs-als-wasm':'quickjs-als'
  promise=(async()=>{
  const wrapper=await import(/* @vite-ignore */runtimeAssetURL(path+'/core.mjs',assetBaseURL).href)
  return wrapper.newQuickJSWASMModuleFromVariant(newVariant({
  ...SYNC,importModuleLoader:async()=>{
    const url=runtimeAssetURL(path+'/engine.mjs',assetBaseURL).href
    return (await import(/* @vite-ignore */ url)).default
  },
},{wasmLocation:runtimeAssetURL(path+'/engine.wasm',assetBaseURL).href}))
  })()
  enginePromises.set(guestWasm,promise);return promise
}

// Heartbeats prove that the worker can still service host messages while a
// blocking process/socket RPC waits for I/O. They never reset guest CPU budgets.
const heartbeat=setInterval(()=>self.postMessage({type:'heartbeat'}),1000)
self.onmessage=event=>{
  const {id,method,args}=event.data
  handle(id,method,args).then(value=>{
    completeKernelWorkerRequest(method,()=>self.postMessage({id,value}),()=>clearInterval(heartbeat),()=>self.close())
  },error=>self.postMessage({id,error:String(error)}))
}
async function handle(id:number,method:string,args:unknown[]){
  if(!Number.isSafeInteger(id)||!Array.isArray(args))throw Error('Invalid kernel message')
  if(method==='init'){
    if(files)throw Error('Kernel already initialized')
    assetBaseURL=resolveRuntimeAssetBase(args[4])
    limits=kernelLimits(args[1] as Partial<KernelLimits>)
    workerMaxBytes=workerMemoryLimit(limits,args[7])
    experimentalCompiler=compilerPolicy(args[8])
    experimentalRolldownParser=rolldownParserPolicy(args[9])
    if(args[3]!==undefined&&typeof args[3]!=='boolean')throw Error('Invalid cooperative engine option')
    cooperative=args[3]===true
    if(args[5]!==undefined&&typeof args[5]!=='boolean')throw Error('Invalid experimental fiber option')
    experimentalFibers=args[5]===true
    sharedMemoryPerEngine=sharedMemoryPerEngineLimits(args[6] as Partial<KernelSharedMemoryPerEngineLimits>|undefined,experimentalFibers)
    if(experimentalFibers&&cooperative)throw Error('Fiber and cooperative candidates cannot be combined')
    const workspace=workspaceLimits(args[2] as Partial<KernelWorkspaceLimits>)
    files=new WorkspaceFiles(args[0] as Record<string,string|Uint8Array>,workspace.maxBytes,workspace.maxFiles)
    descriptors=new FileDescriptors(files)
    fileSessions=new WorkspaceFileSessions(files)
    return
  }
  if(!files)throw Error('Kernel is not initialized')
  if(method==='shutdown'){
    shuttingDown=true
    installation?.abort(Error('Kernel closed'))
    try{
      if(processes.active.length||nativeParser||synchronousCompiler){
        const hasCompilers=Boolean(nativeParser||synchronousCompiler)
        if(hasCompilers)nativeParserState='closing'
        try{
          await shutdownKernelResources(processes.active,(owner,pid)=>processes.kill(owner,pid,'SIGKILL'),[nativeParser,synchronousCompiler])
          if(hasCompilers)nativeParserState='closed'
        }catch(error){if(hasCompilers)nativeParserState='failed';throw error}
      }
    }finally{fileSessions!.close();fileSessionLeases.clear()}
    return
  }
  if(shuttingDown&&method!=='resources')throw Error('Kernel is shutting down')
  if(method==='fileSessionOpen'){
    if(nextFileSession>=Number.MAX_SAFE_INTEGER)throw Error('File session IDs exhausted')
    const lease=fileSessions!.open(args[0] as boolean),key=++nextFileSession
    fileSessionLeases.set(key,lease);return key
  }
  if(method==='fileSessionCall'||method==='fileSessionClose'){
    const lease=fileSessionLeases.get(args[0] as number)
    if(!lease){if(method==='fileSessionClose')return;throw Error('EBADF: file session closed')}
    if(method==='fileSessionClose'){lease.close();fileSessionLeases.delete(args[0] as number);return}
    if(installation)throw Error('Kernel is installing packages')
    return lease.call(args[1] as string,args[2] as unknown[])
  }
  if(method==='spawn'){
    if(installation)throw Error('Kernel is installing packages')
    return processes.start(0,prepareProcess(args[0] as string,args[1] as string[],args[2] as SpawnOptions)).pid
  }
  if(method==='spawnShell'){
    if(installation)throw Error('Kernel is installing packages')
    return processes.start(0,prepareShellProcess(args[0],args[1] as SpawnOptions)).pid
  }
  if(method==='processNext')return processes.next(0,args[0] as number)
  if(method==='processWait'){const record=processes.get(0,args[0] as number);return {...await record.result,signal:record.signal}}
  if(method==='processWrite')return processes.writeInput(0,args[0] as number,args[1] as Uint8Array)
  if(method==='processEnd')return processes.endInput(0,args[0] as number)
  if(method==='processKill')return processes.kill(0,args[0] as number,args[1] as string)
  if(method==='processForget')return processes.forget(0,args[0] as number)
  if(method==='netConnect')return network.connect(0,args[0] as number,args[1] as string)
  if(method==='netRead')return network.next(0,args[0] as number)
  if(method==='netWrite')return network.write(0,args[0] as number,args[1] as Uint8Array)
  if(method==='netEnd')return network.end(0,args[0] as number)
  if(method==='netDestroy')return network.destroy(0,args[0] as number)
  if(method==='snapshot')return files.snapshot()
  if(method==='restore'){
    files.replace(args[0] as import('./files').WorkspaceSnapshot)
    fileSessions!.close();fileSessionLeases.clear();fileSessions=new WorkspaceFileSessions(files)
    return
  }
  if(method==='saveCheckpoint')return saveKernelCheckpoint(args[0] as string,files.snapshot())
  if(method==='restoreCheckpoint'){
    const restored=await restoreKernelCheckpoint(args[0] as string)
    files.replace(restored.snapshot)
    fileSessions!.close();fileSessionLeases.clear();fileSessions=new WorkspaceFileSessions(files)
    return restored.metadata
  }
  if(method==='deleteCheckpoint')return deleteKernelCheckpoint(args[0] as string)
  if(method==='checkpointMetadata')return kernelCheckpointMetadata(args[0] as string)
  // Host editing tools may create parents. Guest node:fs writes do not.
  if(method==='writeFile')return files.writeFileSync(args[0] as string,args[1] as Uint8Array)
  if(method==='cancelInstall'){
    if(args.length===0||args[0]===installationToken)installation?.abort(new Error('Package installation cancelled'))
    return
  }
  if(method==='resources'){
    if((nativeParserInstance?.closed||synchronousCompilerInstance?.closed)&&nativeParserState==='active')nativeParserState='failed'
    const nativeSessions=[nativeParserInstance,synchronousCompilerInstance].filter(parser=>parser&&!parser.closed).length
    return {
    processes:{active:processes.active.length,retained:processes.size},
    network:{handles:network.size,listeners:network.listening,details:network.snapshot()},datagrams:{handles:datagrams.size,bound:datagrams.bound},
    fileSessions:fileSessionLeases.size,executing:active,installing:Boolean(installation),
    nativeParser:{enabled:Boolean(experimentalRolldownParser),state:nativeParserState,
      reservedInitialBytes:experimentalRolldownParser?(nativeParserInstance&&!nativeParserInstance.closed?rolldownParserResources.initialPages*65536:0)+(synchronousCompilerInstance&&!synchronousCompilerInstance.closed?rolldownSynchronousCompilerResources.initialPages*65536:0):0,
      reservedMaximumBytes:experimentalRolldownParser?(nativeParserInstance&&!nativeParserInstance.closed?rolldownParserResources.maximumPages*65536:0)+(synchronousCompilerInstance&&!synchronousCompilerInstance.closed?rolldownSynchronousCompilerResources.maximumPages*65536:0):0,
      activeSessions:nativeSessions,pendingCalls:nativeParserCalls,
      completedCalls:nativeParserCompletedCalls,failedCalls:nativeParserFailedCalls,
      pendingSourceBytes:nativeParserPendingSourceBytes,maxPendingSourceBytes:experimentalRolldownParser?.maxSourceBytes??0,
      callable:{completed:nativeCallableCompleted,failed:nativeCallableFailed,handles:nativeCallableHandles,activeRoutes:nativeCallableRoutes.size,pendingBytes:nativeCallablePendingBytes},
      bundlers:{active:[...nativeBundlerSnapshots].map(([pid,snapshot])=>({pid,state:snapshot()})),retired:[...retiredBundlerSnapshots]},
      shutdownPending:shuttingDown&&nativeParserState==='closing'},
    }
  }
  if(method==='install'){
    if(active||installation||processes.active.length)throw Error('Kernel is busy')
    const controller=installation=new AbortController()
    installationToken=args[1]
    let lastProgress=-Infinity
    const activity=()=>{const now=performance.now();if(now-lastProgress>=1000){lastProgress=now;self.postMessage({id,type:'progress'})}}
    try{return await installProject(files,args[0] as ProjectInstallOptions,controller.signal,task=>runPackageLifecycle(task,controller.signal),activity)}finally{installation=undefined;installationToken=undefined}
  }
  if(method==='execute'){
    if(active||installation)throw Error('Kernel already has an active execution or installation')
    active=true
    try{
      const settings=args[1] as Options,validated=executionLimits(limits,settings)
      if(settings?.lifetime!==undefined&&settings.lifetime!=='bounded')throw Error('Session lifetime requires spawn()')
      validateExecution(args[0],settings)
      const cwd=processDirectory(files,settings?.cwd??'/')
      const record=processes.start(0,{code:args[0] as string,entry:settings?.entry,argv:['/usr/bin/browser-node',settings?.entry??processPath(cwd,'workspace.mjs')],options:{...settings,...validated,cwd}},(level,text)=>self.postMessage({id,type:'output',level,text}),false)
      try{return await record.result}finally{processes.forget(0,record.pid)}
    }finally{active=false}
  }
  return fileCallSync(files,true,method,args)
}
interface Options extends SpawnOptions {entry?:string;loadModules?:boolean;evalCommonJS?:boolean}
async function executeManagedJavaScript(record:ManagedProcess){
  const input=record.input
  if(input.kind==='shell')throw Error('Expected JavaScript process')
  // Match a candidate only after normal command resolution. Exact source hashes
  // below decide whether it can use the native backend, not the package name.
  if(experimentalCompiler&&input.entry?.endsWith('/bin/esbuild')){
    if(input.ipc||input.worker||input.options.terminal||input.execArgv?.length)throw Error('Experimental compiler requires an ordinary process without IPC, terminal or Node flags')
    const compilerLifetime=input.options.lifetime??'bounded'
    if(compilerLifetime==='session'&&(experimentalCompiler.lifetime!=='session'||!input.argv.slice(2).includes('--service=0.28.2')||input.argv.slice(2).some(arg=>arg!=='--service=0.28.2'&&arg!=='--ping')))throw Error('Compiler session requires explicit owner policy and the pinned service protocol')
    const approved=executionLimits(limits,input.options)
    const maxPages=Math.min(experimentalCompiler.maxMemoryPages,Math.floor(approved.maxBytes/65536))
    const started=performance.now()
    const artifact=await prepareEsbuildArtifact(files!,input.entry,maxPages)
    record.controller.signal.throwIfAborted()
    const timeoutMs=Math.min(experimentalCompiler.timeoutMs,approved.timeoutMs)-(performance.now()-started)
    if(timeoutMs<1)throw Error('Compiler workflow deadline exceeded during preparation')
    const workspace=new CompilerWorkspace(fileSessions!,input.options.writable!==false)
    let stdout='',stderr='',outputBytes=0
    const decoders={stdout:new TextDecoder(),stderr:new TextDecoder()}
    const output=async(type:'stdout'|'stderr',bytes:Uint8Array)=>{
      const fd=type==='stdout'?1:2
      if(record.owner===0&&record.stdio[fd]==='pipe'){
        if(outputBytes+bytes.length>1024*1024)throw Error('Output quota exceeded')
        outputBytes+=bytes.length
        const text=decoders[type].decode(bytes,{stream:true})
        if(type==='stdout')stdout+=text;else stderr+=text
        if(text)record.output?.(type==='stdout'?'log':'error',text)
      }
      await processes.writeOutput(record,{type,bytes})
    }
    try{
      const result=await runBrowserCompiler({
        createWorker:()=>createBrowserCompilerWorker(assetBaseURL),
        bytes:artifact.bytes,maxMemoryPages:maxPages,argv:['esbuild',...input.argv.slice(2)],
        cwd:record.cwd,env:input.options.env??{},timeoutMs:Math.floor(timeoutMs),lifetime:compilerLifetime,signal:record.controller.signal,
        call:(method,args)=>workspace.call(method,args),
        readStdin:async()=>{record.stdinRef=true;const bytes=await record.stdin.read(record.pid,65536);if(bytes===null)record.stdinRef=false;return bytes},
        writeStdout:bytes=>output('stdout',bytes),
        writeStderr:bytes=>output('stderr',bytes),
      })
      stdout+=decoders.stdout.decode();stderr+=decoders.stderr.decode()
      return {exitCode:result.code,stdout,stderr,duration:performance.now()-started,wasmHeapBytes:0}
    }finally{record.stdinRef=false;record.stdin.cancelRead(record.pid);workspace.close()}
  }
  return execute(record.pid,input.code,{...input.options,entry:input.entry,loadModules:input.loadModules,evalCommonJS:input.evalCommonJS},record)
}
function prepareProcess(command:string,args:string[]=[],settings:SpawnOptions={},parent?:ManagedProcess):ProcessInput{
  const fail=(code:string,message:string)=>Object.assign(Error(message),{code})
  if(typeof command!=='string'||command.includes('\0')||command.length>4096||!Array.isArray(args)||args.length>1024||args.some(arg=>typeof arg!=='string'||arg.includes('\0'))||JSON.stringify(args).length>1024*1024)throw fail('EINVAL','Invalid process command or arguments')
  const options=prepareProcessOptions(settings,parent)
  const cwd=options.cwd!
  const argv=[...args],execArgv:string[]=[];let module=false
  const interpreter=['node','/usr/bin/node','/usr/bin/browser-node'].includes(command)
  if(interpreter){
    if(argv[0]==='--input-type=module'){module=true;execArgv.push(argv.shift()!)}
    if(argv[0]==='-e'||argv[0]==='--eval'){
      const flag=argv.shift()!;const code=argv.shift();if(code===undefined)throw fail('EINVAL','Missing evaluation source')
      execArgv.push(flag,code)
      validateExecution(code,options)
      return {code,loadModules:true,evalCommonJS:!module,argv:['/usr/bin/browser-node',...argv],execArgv,options}
    }
    if(argv[0]==='--')argv.shift()
    if(!argv.length||argv[0].startsWith('-'))throw fail('ERR_UNSUPPORTED_OPERATION','Unsupported Node command line')
    command=argv.shift()!
  }else if(!command.includes('/')){
    const configured=options.env?.PATH
    const directories:string[]=[]
    if(configured!==undefined)directories.push(...configured.split(':'))
    else for(let directory=cwd;;directory=directory.slice(0,directory.lastIndexOf('/'))||'/'){
      directories.push(directory.replace(/\/$/,'')+'/node_modules/.bin')
      if(directory==='/')break
    }
    let denied=false,found=''
    for(const directory of directories){
      const candidate=processPath(cwd,(directory||'.').replace(/\/$/,'')+'/'+command)
      if(!files!.entryExistsSync(candidate))continue
      const resolved=files!.realpathSync(candidate)
      if(files!.isFileSync(resolved)&&files!.statSync(resolved).mode&0o111){found=candidate;break}
      denied=true
    }
    if(!found)throw fail(denied?'EACCES':'ENOENT',(denied?'Executable permission denied: ':'Executable not found: ')+command)
    command=found
  }
  const entry=resolveProcessEntry(files!,cwd,command,interpreter)
  validateExecution('',options)
  return {code:'',entry,argv:['/usr/bin/browser-node',entry,...argv],execArgv,options}
}
function prepareProcessOptions(settings:SpawnOptions={},parent?:ManagedProcess):SpawnOptions{
  const fail=(code:string,message:string)=>Object.assign(Error(message),{code})
  if(!settings||typeof settings!=='object'||Array.isArray(settings))throw fail('EINVAL','Invalid process options')
  const cwd=processDirectory(files!,settings.cwd??parent?.cwd??'/',parent?.cwd??'/')
  const inherited=parent?.input.options??{}
  const policy=parent?{maxBytes:inherited.maxBytes??16*1024*1024,timeoutMs:inherited.timeoutMs??5000}:limits
  const budgets=parent?childExecutionLimits(policy,settings):executionLimits(policy,settings)
  const env=settings.env??inherited.env??{}
  if(!env||typeof env!=='object'||Array.isArray(env)||Object.entries(env).some(([key,value])=>key.includes('\0')||key.includes('=')||typeof value!=='string'||value.includes('\0'))||JSON.stringify(env).length>65536)throw fail('EINVAL','Invalid process environment')
  const lifetime=processLifetime(settings.lifetime,parent?inherited.lifetime??'bounded':undefined)
  const options:SpawnOptions={...inherited,...settings,...budgets,lifetime,cwd,env:{...env},stdio:processStdio(settings.stdio)}
  if(parent){if(settings.terminal!==undefined)throw fail('ERR_UNSUPPORTED_OPERATION','Only the owner can attach a terminal');delete options.terminal}
  if(parent){options.writable=inherited.writable;options.guestWasm=inherited.guestWasm;options.webAPIs=inherited.webAPIs;options.workspaceFetch=inherited.workspaceFetch;options.externalFetch=inherited.externalFetch}
  return options
}
function prepareShellProcess(script:unknown,settings:SpawnOptions={},parent?:ManagedProcess):ProcessInput{
  const fail=(code:string,message:string)=>Object.assign(Error(message),{code})
  if(typeof script!=='string'||script.includes('\0')||script.length>65536||new TextEncoder().encode(script).byteLength>65536)throw fail('EINVAL','Invalid shell command')
  const options=prepareProcessOptions(settings,parent)
  return {kind:'shell',script,argv:['/bin/sh','-c',script],options}
}
async function runPackageLifecycle(task:PackageLifecycleTask,signal:AbortSignal){
  const options=prepareProcessOptions({cwd:task.cwd,env:task.env,writable:true,guestWasm:true,webAPIs:true,timeoutMs:limits.timeoutMs,stdio:'pipe'})
  const record=processes.start(0,{kind:'shell',script:task.script,argv:['/bin/sh','-c',task.script],options})
  const abort=()=>{if(record.running)processes.kill(0,record.pid,'SIGTERM')}
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()
  try{
    const result=await record.result
    let stdout='',stderr=''
    for(;;){
      const event=await processes.next(0,record.pid);if(event===null)break
      if(event.type==='stdout')stdout+=new TextDecoder().decode(event.bytes)
      if(event.type==='stderr')stderr+=new TextDecoder().decode(event.bytes)
    }
    signal.throwIfAborted()
    if(result.exitCode!==0)throw Object.assign(Error('Package '+task.event+' script failed in '+task.cwd+(stderr?'\n'+stderr:'')),{code:result.exitCode,stdout,stderr,event:task.event,path:task.cwd})
  }finally{signal.removeEventListener('abort',abort);if(record.running)processes.kill(0,record.pid,'SIGKILL');await record.result;processes.forget(0,record.pid)}
}
function guestError(error:any){return error?.message?(error.name?error.name+': ':'')+error.message+(error.stack?'\n'+error.stack:''):JSON.stringify(error)}
function validateExecution(code:unknown,options:Options={}){
  if(options.workspaceFetch&&!options.webAPIs)throw Error('Workspace fetch requires guest Web APIs')
  externalFetchPolicy(options.externalFetch,options.webAPIs)
  if(typeof code!=='string'||code.length>8*1024*1024||new TextEncoder().encode(code).byteLength>8*1024*1024)throw Error('Invalid execution limits')
}
function externalFetchPolicy(value:Options['externalFetch'],webAPIs:unknown){
  if(value===undefined)return undefined
  if(!webAPIs)throw Error('External fetch requires guest Web APIs')
  if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('Invalid external fetch policy')
  if(!Array.isArray(value.allowedOrigins)||value.allowedOrigins.length<1||value.allowedOrigins.length>32)throw new TypeError('Invalid external fetch origins')
  const origins=value.allowedOrigins.map(input=>{
    if(typeof input!=='string'||input.length>2048)throw new TypeError('Invalid external fetch origin')
    const url=new URL(input)
    if(url.protocol!=='https:'||url.username||url.password||url.origin!==input||url.pathname!=='/'||url.search||url.hash)throw new TypeError('External fetch origins must be exact HTTPS origins')
    return url.origin
  })
  if(new Set(origins).size!==origins.length)throw new TypeError('Duplicate external fetch origin')
  const bounded=(input:unknown,fallback:number,max:number)=>{
    const result=input===undefined?fallback:input
    if(!Number.isSafeInteger(result)||Number(result)<1||Number(result)>max)throw new TypeError('Invalid external fetch limit')
    return Number(result)
  }
  const policy={allowedOrigins:new Set(origins),maxRequests:bounded(value.maxRequests,32,128),maxResponseBytes:bounded(value.maxResponseBytes,8*1024*1024,32*1024*1024),maxTotalBytes:bounded(value.maxTotalBytes,32*1024*1024,64*1024*1024)}
  if(policy.maxResponseBytes>policy.maxTotalBytes)throw new TypeError('External fetch response limit exceeds total limit')
  return policy
}
async function executeShell(record:ManagedProcess){
  if(record.input.kind!=='shell')throw Error('Expected shell process input')
  const started=performance.now(),lease=fileSessions!.open(!!record.input.options.writable)
  const children=new Set<number>()
  const call=async(method:string,args:any[])=>{
    if(record.controller.signal.aborted)record.controller.signal.throwIfAborted()
    if(method==='process.spawn'){
      if(!Array.isArray(args[0])||!args[0].length||args[0].some((value:unknown)=>typeof value!=='string'))throw Object.assign(Error('Invalid shell command'),{code:'EINVAL'})
      const [command,...argv]=args[0]
      const child=processes.start(record.pid,prepareProcess(command,argv,{cwd:args[1],env:args[2],stdio:'pipe'},record))
      children.add(child.pid);return child.pid
    }
    if(method.startsWith('process.')){
      const pid=args[0]
      if(!Number.isSafeInteger(pid)||!children.has(pid))throw Object.assign(Error('Unknown shell child'),{code:'ESRCH'})
      if(method==='process.next')return processes.next(record.pid,pid)
      if(method==='process.end')return processes.endInput(record.pid,pid)
      if(method==='process.kill')return processes.kill(record.pid,pid,'SIGKILL')
      if(method==='process.write'){
        if(!(args[1] instanceof Uint8Array)||args[1].byteLength>65536)throw Object.assign(Error('Invalid shell stdin chunk'),{code:'EINVAL'})
        return processes.writeInput(record.pid,pid,args[1])
      }
      if(method==='process.dispose'){
        const child=processes.get(record.pid,pid)
        if(child.running)processes.kill(record.pid,pid,'SIGKILL')
        await child.result;processes.forget(record.pid,pid);children.delete(pid);return
      }
      throw Object.assign(Error('Unsupported shell process operation'),{code:'ENOTSUP'})
    }
    return lease.call(method,args)
  }
  try{
    const result=await runMvdanWorker({
      assetBaseURL,script:record.input.script,timeoutMs:record.input.options.timeoutMs??5000,
      cwd:record.cwd,env:record.input.options.env??{},signal:record.controller.signal,lifetime:record.input.options.lifetime,call,
      readStdin:async()=>{
        record.stdinRef=true
        const bytes=await record.stdin.read(record.pid,16384)
        if(bytes===null)record.stdinRef=false
        return bytes
      },
      writeStdout:bytes=>processes.writeOutput(record,{type:'stdout',bytes}),
      writeStderr:bytes=>processes.writeOutput(record,{type:'stderr',bytes}),
    })
    return {exitCode:result.code,stdout:'',stderr:'',duration:performance.now()-started,wasmHeapBytes:0}
  }finally{
    record.stdinRef=false;record.stdin.cancelRead(record.pid);lease.close()
    await Promise.all([...children].map(async pid=>{
      try{
        const child=processes.get(record.pid,pid)
        if(child.running)processes.kill(record.pid,pid,'SIGKILL')
        await child.result;processes.forget(record.pid,pid)
      }catch{}
    }))
    children.clear()
  }
}
async function execute(id:number,code:string,options:Options={},record:ManagedProcess){
  if(options.workspaceFetch&&!options.webAPIs)throw Error('Workspace fetch requires guest Web APIs')
  const externalPolicy=externalFetchPolicy(options.externalFetch,options.webAPIs)
  const {maxBytes,timeoutMs}=executionLimits(limits,options)
  if(typeof code!=='string'||code.length>8*1024*1024||new TextEncoder().encode(code).byteLength>8*1024*1024)throw Error('Invalid execution limits')
  const started=performance.now()
  const budget=new ExecutionBudget(timeoutMs,options.lifetime)
  const {candidate,engineReady,engine,tls,http2}=await withStartupDeadline(record.controller.signal,timeoutMs,async signal=>{
    const candidate=cooperative?await createCooperativeEngine(!!options.guestWasm,signal,assetBaseURL):undefined
    const engineReady=performance.now()
    const [engine,tls,http2]=await Promise.all([candidate?candidate.engine:experimentalFibers?getFiberEngine(assetBaseURL,options.guestWasm,sharedMemoryPerEngine.maxBytes,sharedMemoryPerEngine.growthReservation):getEngine(options.guestWasm),getTLSBackend(),getHTTP2Backend()])
    return {candidate,engineReady,engine,tls,http2}
  })
  const runtime=engine.newRuntime()
  const clockStart=performance.now(),timeOrigin=Date.now()
  runtime.setMemoryLimit(maxBytes)
  /* QuickJS measures this guard from the active fiber's stack top. The fiber
   * owns a separate 512 KiB native stack, so keep 128 KiB outside QuickJS for
   * the C frames used by the wrapper, Asyncify and host transitions. */
  runtime.setMaxStackSize((experimentalFibers?384:512)*1024)
  let interruptCalls=0,interruptMs=0
  let interruptReported=false
  const checkInterrupt=()=>{
    const cancelled=record.controller.signal.aborted
    const expired=!cancelled&&budget.expired
    if((cancelled||expired)&&!interruptReported){
      interruptReported=true
      self.postMessage({type:'job-profile',value:{pid:id,phase:'interrupt',at:performance.now(),ms:performance.now()-started,jobs:0,reason:cancelled?'cancelled':'deadline',budget:budget.snapshot()}})
    }
    return cancelled||expired
  }
  runtime.setInterruptHandler(options.profileJobs?()=>{
    const start=performance.now()
    try{return checkInterrupt()}
    finally{interruptCalls++;interruptMs+=performance.now()-start}
  }:checkInterrupt)
  const context=runtime.newContext()
  const sharedSender=experimentalFibers?new SharedMessageSender():undefined
  const moduleSender=options.guestWasm?new ModuleMessageSender(moduleMessageBudget):undefined
  const sendResources=<T>(shared:unknown,modules:unknown,accept:(resources:MessageResource[])=>T):T=>{
    const sendModules=(resources:MessageResource[])=>moduleSender?moduleSender.send(modules??[],message=>accept([...resources,message])):accept(resources)
    return sharedSender?sharedSender.send(shared??[],message=>sendModules([message])):sendModules([])
  }
  let moduleResolveHook:ReturnType<typeof context.newString>|undefined
  let moduleLoadHook:ReturnType<typeof context.newString>|undefined
  const contextReady=performance.now()
  const executeJobs=context.getProp(context.global,'__qjsExecutePendingJobs')
  context.unwrapResult(context.evalCode(taskQueueBootstrap)).dispose()
  const drainTicks=context.unwrapResult(context.evalCode("()=>globalThis[Symbol.for('web-container:task-queue')].drain()"))
  const jobLimit=context.newNumber(options.profileJobs?1:100)
  const fiberJobs=experimentalFibers?(()=>{
    const factory=context.unwrapResult(context.evalCode('(pump,limit)=>()=>pump(limit)'))
    try{return context.unwrapResult(context.callFunction(factory,context.undefined,executeJobs,jobLimit))}finally{factory.dispose()}
  })():undefined
  let profileSamples=0
  const wasmTotals=new Map<number,{ms:number;calls:number}>()
  const wasmModuleTiming=options.diagnostics&&!options.profileJobs&&options.guestWasm
    ?createWasmModuleTiming((context as unknown as {module:Parameters<typeof createWasmModuleTiming>[0]}).module):undefined
  let cjsCompileCalls=0,cjsCompileMs=0
  let workerStartFailures=0
  const slowCJSCompiles:{path:string;ms:number}[]=[]
  let moduleLoadCalls=0,moduleLoadMs=0,moduleSourceChars=0
  const largestModuleSources:{path:string;chars:number;ms:number}[]=[]
  const profile=(phase:string,start:number,jobs:number,importsMs?:number,imports?:number)=>{
    const ms=performance.now()-start
    if(options.profileJobs&&ms>=25&&profileSamples++<256)self.postMessage({type:'job-profile',value:{pid:id,phase,at:start,ms,jobs,importsMs,imports,interruptCalls,interruptMs,fileCalls:diagnostics?.fileCalls,fileCallMs:diagnostics?.fileCallMs,cjsCompileCalls,cjsCompileMs,scheduling:candidate?.schedulingMetrics()}})
  }
  const timers=new Map<number,{timer:ReturnType<typeof setTimeout>;deferred:QuickJSDeferredPromise;ref:boolean}>()
  const referencedPorts=new Set<number>()
  const pendingWorkerBytes=new Map<number,{token:number;bytes:Uint8Array}>()
  const immediates=new Map<number,{deferred:QuickJSDeferredPromise;ref:boolean}>()
  type WatchEvent={eventType:string;filename:string}
  const watchers=new Map<number,{path:string;directory:boolean;recursive:boolean;ref:boolean;queue:WatchEvent[];pending?:QuickJSDeferredPromise}>()
  let timerId=0,watchId=0,stdout='',stderr='',failure:string|undefined,outputBytes=0,randomBytesUsed=0,callbackFailure:string|undefined,disposed=false
  let failureCause:unknown,failureExitCode=1,pendingInputReads=0,pendingOutputWrites=0,pendingFilesystemTasks=0
  let requestedExit:number|undefined
  let tlsOwner=false,http2Owner=false,nativeReserved=0
  const diagnostics:import('./kernel').KernelExecutionResult['diagnostics']=options.diagnostics?{jobBatches:0,jobs:0,jobPumpMs:0,yieldCount:0,yieldWaitMs:0,fileCalls:0,fileCallMs:0}:undefined
  if(diagnostics)diagnostics.startup={engineMs:engineReady-started,runtimeMs:clockStart-engineReady,contextMs:contextReady-clockStart}
  const bootstrapMarks:Array<{phase:string;at:number}>=[]
  const markBootstrap=(phase:string)=>{if(diagnostics)bootstrapMarks.push({phase,at:performance.now()})}
  const dumpFailure=(handle:Parameters<typeof context.dump>[0],stage:string)=>{
    // Capture native allocation state before the best-effort dumper allocates
    // guest objects or invokes any guest formatting methods.
    if(diagnostics)diagnostics.failure={stage,type:context.typeof(handle),isNull:context.eq(handle,context.null),memory:runtime.dumpMemoryUsage()}
    return context.dump(handle)
  }
  const preserveWorkerError=(value:unknown)=>{
    if(!record.input.worker||!value||typeof value!=='object')return
    const error=value as {name?:unknown;message?:unknown;stack?:unknown;code?:unknown}
    record.workerError={
      name:typeof error.name==='string'?error.name:'Error',
      message:typeof error.message==='string'?error.message:String(value),
      stack:typeof error.stack==='string'?error.stack:undefined,
      code:typeof error.code==='string'?error.code:undefined,
    }
  }
  const hostTasks:import('./task-scheduler').TaskSchedulerSample[]=[]
  const hostTaskTrace={pid:id,count:0,dropped:0,hostTasks}
  let emitLiveScheduling:(()=>void)|undefined
  if(diagnostics&&activeHostTaskTraces.size<32)activeHostTaskTraces.set(id,hostTaskTrace)
  const scheduler=new TaskScheduler(diagnostics?sample=>{
    hostTaskTrace.count++
    if(hostTasks.length===64){hostTasks.shift();hostTaskTrace.dropped++}
    hostTasks.push(sample)
    emitLiveScheduling?.()
  }:undefined)
  const engineAccess=new EngineAccess(512,diagnostics?()=>performance.now():undefined)
  const workerMessageTiming=diagnostics?new WorkerMessageTiming(()=>performance.now(),96,sample=>self.postMessage({type:'worker-lifecycle',value:{pid:id,sample}}),!options.profileJobs):undefined
  const workerPoll=new WorkerPoll(endpoint=>processes.workerPollSnapshot(id,endpoint))
  const fiberTiming={steps:0,totalMs:0,maxMs:0,parked:0,fairnessYields:0}
  const fiberPhaseTiming=diagnostics?createFiberPhaseTiming():undefined
  const schedulerCheckpoints:Array<{at:number;phase:string;pollRemaining:number;checkCallbacks:number;completions:number;guestJobsBefore:boolean;guestJobsAfter?:boolean;pumpMs?:number;beforeYieldMs?:number;yieldMs?:number}>=[]
  const checkBatches:Array<{sequence:number;at:number;callbacks:number;dispatched:number;cancelled:number;completions:number;queued:ReturnType<EngineAccess['pendingSnapshot']>;sources:ReturnType<EngineAccess['pendingSources']>;ports:ReturnType<WorkerPoll['diagnosticSnapshot']>;endAt?:number;endCompletions?:number;nextImmediates?:number}>=[]
  let checkBatchCount=0,activeCheckBatch:(typeof checkBatches)[number]|undefined
  let requestedFiberWait:number|undefined
  // quickjs-emscripten-core stores the runtime pointer in its rt Lifetime,
  // not the context pointer. The optional ABI owns this runtime's sample ring.
  const samplingRuntime=runtime as unknown as {module:GuestSamplingModule;rt:{value:number}}
  const guestSampling=options.diagnostics?createGuestSamplingReader(samplingRuntime.module,samplingRuntime.rt.value):undefined
  const guestSamplingBoundaries=guestSampling?createGuestSamplingBoundaries(guestSampling,snapshot=>self.postMessage({type:'guest-samples',value:{pid:id,...snapshot}})):undefined
  if(diagnostics)emitLiveScheduling=createLiveSchedulingDiagnostics((at,sequence)=>{
    self.postMessage({type:'job-profile',value:{pid:id,phase:'live-scheduling',at,ms:0,jobs:diagnostics.jobs,sequence,
      pendingFilesystemTasks,
      engineAccess:{busy:engineAccess.busy,pending:engineAccess.pending,sources:engineAccess.pendingSources(),timing:engineAccess.snapshot()},
      checkpoint:schedulerCheckpoints.at(-1),fiberTiming:{...fiberTiming},schedulerEvent:hostTasks.at(-1),
      fiberPhases:fiberPhaseTiming?.snapshot(),cjsCompileCalls,cjsCompileMs,moduleLoadCalls,moduleLoadMs,
      wasmTotals:[...wasmTotals].slice(0,3).map(([op,total])=>({op,...total})),
      wasmModuleTiming:wasmModuleTiming?.snapshot(),
    }})
  })
  const driveFiber=async(fiber:Parameters<typeof runKernelFiber>[0],phase:FiberDiagnosticPhase)=>{
    guestSamplingBoundaries?.begin()
    try{return await runKernelFiber(fiber,{scheduler,signal:record.controller.signal,expired:checkInterrupt,waitTimeout:()=>budget.waitTimeout,onStep:diagnostics?(ms,status)=>{guestSamplingBoundaries?.observeStep(status);fiberTiming.steps++;fiberTiming.totalMs+=ms;fiberTiming.maxMs=Math.max(fiberTiming.maxMs,ms);if(status===1)fiberTiming.parked++;if(status===3)fiberTiming.fairnessYields++;fiberPhaseTiming?.observe(phase,ms,status);emitLiveScheduling?.()}:undefined,takeWait:()=>{
    if(requestedFiberWait===undefined)throw Error('Fiber parked without a host wait request')
    const delay=requestedFiberWait;requestedFiberWait=undefined;return delay
    }})}finally{
      // runKernelFiber has taken the result and disposed the completed fiber.
      // Failed or suspended stacks are never inspected by this diagnostic.
      guestSamplingBoundaries?.completed()
    }
  }
  const complete=(callback:()=>void,workerEndpoint?:number,source:CompletionSource='other')=>{
    if(disposed)return
    try{engineAccess.enqueue(()=>{if(!disposed){budget.beginTurn();callback()}},workerEndpoint,source)}
    catch(error){callbackFailure='Host completion failed: '+String(error)}
    scheduler.wake()
  }
  record.wake=()=>scheduler.wake()
  const intl=new IntlDateTimeBackend()
  const networkPromises=new Set<QuickJSDeferredPromise>()
  let closeCallableProcess:()=>Promise<void>=async()=>{}
  let closeBundlerProcess:()=>Promise<void>=async()=>{}
  let referencedBundlerWork:()=>boolean=()=>false
  let pendingNativeCompilerCalls=0
  let networkPendingBytes=0
  const outputDecoders=new Map([[1,new TextDecoder()],[2,new TextDecoder()]])
  const reserveOutput=(fd:number,bytes:number)=>{
    if(record.stdio[fd]==='ignore'||(record.owner!==0&&record.stdio[fd]==='pipe'))return
    if(outputBytes+bytes>1024*1024)throw Object.assign(Error('Output quota exceeded'),{code:'ERR_RESOURCE_LIMIT'})
    outputBytes+=bytes
  }
  const emitOutput=(level:string,text:string,raw?:Uint8Array)=>{
    const fd=level==='error'||level==='warn'?2:1
    if(record.owner===0&&record.stdio[fd]==='pipe'){
      if(fd===2)stderr+=text;else stdout+=text
      if(text)record.output?.(level,text)
    }
    const bytes=raw??new TextEncoder().encode(text)
    if(bytes.length)processes.emit(record,{type:level==='error'||level==='warn'?'stderr':'stdout',bytes})
  }
  record.receiveOutput=event=>{
    const fd=event.type==='stderr'?2:1
    reserveOutput(fd,event.bytes.length)
    emitOutput(fd===2?'error':'log',outputDecoders.get(fd)!.decode(event.bytes,{stream:true}),event.bytes)
  }
  const errorHandle=(error:unknown)=>{
    const handle=error instanceof Error?context.newError(error):context.newError(String(error))
    const code=(error as {code?:unknown})?.code
    if(typeof code==='string'){const value=context.newString(code);context.setProp(handle,'code',value);value.dispose()}
    const tlsCode=(error as {tlsCode?:unknown})?.tlsCode
    if(typeof tlsCode==='number'){const value=context.newNumber(tlsCode);context.setProp(handle,'tlsCode',value);value.dispose()}
    return handle
  }
  // A pending socket read or write inherits liveness from its socket handle.
  // Counting every transport promise here makes an unref'ed server's idle
  // accept loop keep the process alive forever. VirtualNetwork already tracks
  // handle ref state, matching Node's ref()/unref() contract.
  const referenced=()=>referencedBundlerWork()||pendingNativeCompilerCalls>0||pendingFilesystemTasks>0||referencedPorts.size>0||pendingInputReads>0||pendingOutputWrites>0||record.stdinRef||(record.ipcRef&&record.ipc?.toChild.connected)||(record.workerRef&&record.workerChannel?.toChild.connected)||processes.hasChildren(id)||network.hasReferences(id)||datagrams.hasReferences(id)||[...timers.values(),...watchers.values(),...immediates.values()].some(entry=>entry.ref)
  let watcherFlushQueued=false
  const flushWatchers=()=>{
    if(disposed)return
    if(watcherFlushQueued)return
    watcherFlushQueued=true
    complete(()=>{
      watcherFlushQueued=false
      for(const watcher of watchers.values())if(watcher.pending&&watcher.queue.length){
        const value=context.newString(JSON.stringify(watcher.queue.shift()))
        watcher.pending.resolve(value);value.dispose();watcher.pending.dispose();watcher.pending=undefined
      }
    },undefined,'watcher')
  }
  const unsubscribe=files!.subscribe(event=>{
    for(const watcher of watchers.values()){
      const prefix=watcher.path==='/'?'/':watcher.path+'/'
      const filename=watcher.directory?watchEventFilename(watcher.path,event.path):event.path.split('/').pop()!
      if(watcher.directory?(!event.path.startsWith(prefix)||(!watcher.recursive&&filename.includes('/'))):event.path!==watcher.path)continue
      if(watcher.queue.length>=256){callbackFailure='Filesystem watch event quota exceeded';break}
      watcher.queue.push({eventType:event.eventType,filename})
    }
    // Never enter QuickJS again from inside a synchronous guest file call.
    queueMicrotask(flushWatchers)
  })
  const expose=(name:string,callback:Parameters<typeof context.newFunction>[1])=>{
    const value=context.newFunction(name,function(...args){try{return candidate?candidate.synchronous(()=>callback.apply(this,args)):callback.apply(this,args)}catch(error){return {error:errorHandle(error)}}})
    context.setProp(context.global,name,value);value.dispose()
  }
  try{
    if(experimentalFibers){
      expose('__requestFiberWait',value=>{
        const delay=context.getNumber(value)
        if(!Number.isInteger(delay)||delay<0||delay>1000||requestedFiberWait!==undefined)throw Error('Invalid experimental fiber wait')
        requestedFiberWait=delay
      })
      const initializer=context.unwrapResult(context.evalCode('(park)=>{const request=globalThis.__requestFiberWait;delete globalThis.__requestFiberWait;globalThis.__qjsFiberWait=(ms)=>{request(ms);return park()}}'))
      try{context.unwrapResult((context as FiberContext).initializeFiber(initializer)).dispose()}finally{initializer.dispose()}
    }
    expose('__intlCall',(methodValue,argsValue)=>{
      if(record.controller.signal.aborted||budget.expired)throw Object.assign(Error('Intl operation cancelled or execution budget exceeded'),{code:'ECANCELED'})
      try{
        const method=context.getString(methodValue),json=context.getString(argsValue)
        if(json.length>32768)throw Object.assign(Error('Intl request exceeds transport limit'),{code:'ERR_RESOURCE_LIMIT'})
        const value=intl.call(method,JSON.parse(json))
        if(record.controller.signal.aborted||budget.expired)throw Object.assign(Error('Intl operation cancelled or execution budget exceeded'),{code:'ECANCELED'})
        const result=JSON.stringify({value})
        if(result.length>65536)throw Object.assign(Error('Intl response exceeds transport limit'),{code:'ERR_RESOURCE_LIMIT'})
        return context.newString(result)
      }catch(error){
        return context.newString(JSON.stringify({error:{name:error instanceof Error?error.name:'Error',message:error instanceof Error?error.message:String(error),code:(error as {code?:string})?.code}}))
      }
    })
    context.unwrapResult(context.evalCode(intlBootstrap,'intl.js')).dispose()
    const reserveNative=(name:string,create:(reserved:number)=>void)=>{
      const reserved=Math.min(4*1024*1024,Math.floor(maxBytes/4)),remaining=maxBytes-nativeReserved-reserved
      const usage=runtime.computeMemoryUsage()
      let allocated:number
      try{allocated=(context.dump(usage) as {malloc_size:number}).malloc_size}finally{usage.dispose()}
      if(!Number.isFinite(allocated)||allocated>remaining)throw Object.assign(Error('Insufficient process memory for '+name),{code:'ERR_RESOURCE_LIMIT'})
      runtime.setMemoryLimit(remaining)
      try{create(reserved);nativeReserved+=reserved}
      catch(error){runtime.setMemoryLimit(maxBytes-nativeReserved);throw error}
    }
    const ensureTLSOwner=()=>{
      if(!tlsOwner)reserveNative('TLS',reserved=>{tls.createOwnerSync(id,{maxBytes:reserved,maxConnections:32});tlsOwner=true})
    }
    expose('__http2Call',(methodValue,argsValue)=>{
      if(record.controller.signal.aborted||budget.expired)throw Object.assign(Error('HTTP/2 operation cancelled or execution budget exceeded'),{code:'ECANCELED'})
      const method=context.getString(methodValue),json=context.getString(argsValue)
      if(json.length>1024*1024)throw Error('HTTP/2 arguments exceed transport limit')
      const args=JSON.parse(json);if(!Array.isArray(args)||args.length>8)throw Error('Invalid HTTP/2 arguments')
      const bytes=(value:unknown)=>{
        if(!Array.isArray(value)||value.length>65536||value.some(byte=>!Number.isInteger(byte)||byte<0||byte>255))throw Error('Invalid HTTP/2 bytes')
        return new Uint8Array(value)
      }
      let value:unknown
      if(method==='open'){
        if(!http2Owner)reserveNative('HTTP/2',reserved=>{http2.createOwnerSync(id,{maxBytes:reserved,maxSessions:32});http2Owner=true})
        value=http2.open(id,args[0])
      }else if(method==='headers')value=http2.headers(id,args[0],args[1],args[2],args[3],args[4])
      else if(method==='trailers')value=http2.trailers(id,args[0],args[1],args[2])
      else if(method==='request')value=http2.request(id,args[0],args[1],args[2],args[3])
      else if(method==='respond')value=http2.respond(id,args[0],args[1],args[2])
      else if(method==='write')value=http2.write(id,args[0],args[1],bytes(args[2]),args[3])
      else if(method==='queued')value=http2.queued(id,args[0],args[1])
      else if(method==='consume')value=http2.consume(id,args[0],args[1],args[2])
      else if(method==='reset')value=http2.reset(id,args[0],args[1],args[2])
      else if(method==='goaway')value=http2.goaway(id,args[0],args[1])
      else if(method==='feed')value=http2.feed(id,args[0],bytes(args[1]))
      else if(method==='send')value=http2.send(id,args[0],args[1])
      else if(method==='events')value=http2.events(id,args[0])
      else if(method==='destroy')value=http2.destroy(id,args[0])
      else throw Error('Unknown HTTP/2 operation')
      if(record.controller.signal.aborted||budget.expired)throw Object.assign(Error('HTTP/2 execution budget exceeded'),{code:'ECANCELED'})
      return context.newString(JSON.stringify(value??null,(_key,entry)=>entry instanceof Uint8Array?Array.from(entry):entry))
    })
    expose('__tlsCall',(methodValue,argsValue)=>{
      if(record.controller.signal.aborted||budget.expired)throw Object.assign(Error('TLS operation cancelled or execution budget exceeded'),{code:'ECANCELED'})
      const method=context.getString(methodValue),json=context.getString(argsValue)
      if(json.length>8*1024*1024)throw Error('TLS arguments exceed transport limit')
      const args=JSON.parse(json);if(!Array.isArray(args))throw Error('Invalid TLS arguments')
      const bytes=(value:unknown)=>{
        if(!Array.isArray(value)||value.length>65536||value.some(byte=>!Number.isInteger(byte)||byte<0||byte>255))throw Error('Invalid TLS bytes')
        return new Uint8Array(value)
      }
      let value:unknown
      if(method==='open'||method==='validate'){
        if(!args[0]||typeof args[0]!=='object'||Array.isArray(args[0]))throw Error('Invalid TLS settings')
        const settings={...args[0],caMode:'node'} as TLSSettings
        for(const name of ['ca','cert','key'] as const)if(Array.isArray(settings[name])){
          const input=settings[name] as unknown as number[]
          if(input.length>(name==='key'?65535:1048575)||input.some(byte=>!Number.isInteger(byte)||byte<0||byte>255))throw Error('Invalid TLS certificate bytes')
          settings[name]=new Uint8Array(input)
        }
        ensureTLSOwner()
        if(method==='validate'){
          const handle=tls.open(id,{...settings,server:false,servername:'localhost'})
          tls.destroy(id,handle);value=null
        }else value=tls.open(id,settings)
      }else if(method==='step')value=tls.step(id,args[0])
      else if(method==='feed')value=tls.feed(id,args[0],bytes(args[1]))
      else if(method==='write')value=tls.write(id,args[0],bytes(args[1]))
      else if(method==='read')value=tls.read(id,args[0])
      else if(method==='drain')value=tls.drain(id,args[0])
      else if(method==='eof')value=tls.eof(id,args[0])
      else if(method==='close')value=tls.close(id,args[0])
      else if(method==='destroy')value=tls.destroy(id,args[0])
      else if(method==='info')value=tls.info(id,args[0])
      else throw Error('Unknown TLS operation')
      if(record.controller.signal.aborted||budget.expired)throw Object.assign(Error('TLS execution budget exceeded'),{code:'ECANCELED'})
      return context.newString(JSON.stringify(value??null,(_key,entry)=>entry instanceof Uint8Array?Array.from(entry):entry))
    })
    const networkPromise=(operation:()=>Promise<unknown>,bytes=0,encode?:(value:unknown)=>ReturnType<typeof context.newString>,workerEndpoint?:number,source:CompletionSource='host-operation')=>{
      if(networkPromises.size>=512||networkPendingBytes+bytes>1024*1024)throw Object.assign(Error('Pending network operation quota exceeded'),{code:'ERR_RESOURCE_LIMIT'})
      const deferred=context.newPromise();networkPromises.add(deferred)
      networkPendingBytes+=bytes
      const settle=(value:unknown,rejected=false)=>{
        if(disposed)return
        budget.beginTurn()
        try{
          const handle=rejected?errorHandle(value):encode?encode(value):context.newString(JSON.stringify(value??null,(_key,entry)=>entry instanceof Uint8Array?Array.from(entry):entry))
          try{if(rejected)deferred.reject(handle);else deferred.resolve(handle)}finally{handle.dispose()}
        }catch(error){callbackFailure='Network completion failed: '+String(error)}
        finally{networkPendingBytes-=bytes;networkPromises.delete(deferred);deferred.dispose();scheduler.wake()}
      }
      Promise.resolve().then(operation).then(value=>complete(()=>settle(value),workerEndpoint,source),error=>complete(()=>settle(error,true),workerEndpoint,source))
      return deferred.handle.dup()
    }
    expose('__filesystemTask',()=>{
      // In-memory filesystem work still completes as an I/O task. Admission
      // shares the bounded completion queue and never re-enters a running VM.
      pendingFilesystemTasks++
      try{return networkPromise(()=>Promise.resolve(null),0,()=>{pendingFilesystemTasks--;return context.null.dup()},undefined,'filesystem')}
      catch(error){pendingFilesystemTasks--;throw error}
    })
    expose('__netCall',(method,args)=>{
      const json=context.getString(args)
      if(json.length>4096)throw Error('Network arguments exceed transport limit')
      const values=JSON.parse(json)
      if(!Array.isArray(values))throw Error('Expected network arguments')
      return context.newString(JSON.stringify(networkCall(network,id,context.getString(method),values))??'null')
    })
    expose('__netNext',handle=>{const key=context.getNumber(handle);return networkPromise(()=>network.next(id,key))})
    expose('__dgramCall',(method,args)=>{const json=context.getString(args);if(json.length>400000)throw Error('Datagram arguments exceed transport limit');const values=JSON.parse(json);if(!Array.isArray(values))throw Error('Expected datagram arguments');return context.newString(JSON.stringify(datagramCall(datagrams,id,context.getString(method),values))??'null')})
    expose('__dgramNext',handle=>{const key=context.getNumber(handle);return networkPromise(()=>datagrams.next(id,key))})
    expose('__processCall',(methodValue,argsValue)=>{
      const json=context.getString(argsValue);if(json.length>2*1024*1024)throw Error('Process arguments exceed transport limit')
      const args=JSON.parse(json),method=context.getString(methodValue);if(!Array.isArray(args))throw Error('Invalid process arguments')
      let value:unknown
      if(method==='spawn')value=processes.start(id,prepareProcess(args[0],args[1],args[2],record)).pid
      else if(method==='shellSpawn')value=processes.start(id,prepareShellProcess(args[0],args[1],record)).pid
      else if(method==='fork'){
        if(args[3]!=='json'&&args[3]!=='advanced')throw new TypeError('Invalid IPC serialization')
        const input=prepareProcess(args[0],args[1],args[2],record)
        input.ipc=true;input.ipcMode=args[3];value=processes.start(id,input).pid
      }
      else if(method==='workerSpawn'){
        const [filename,settings,data]=args
        if(typeof filename!=='string'||typeof data!=='string')throw new TypeError('Invalid worker bootstrap')
        const argv=settings?.argv??[],execArgv=settings?.execArgv??[]
        if(!Array.isArray(argv)||!Array.isArray(execArgv))throw new TypeError('Invalid worker arguments')
        if(settings?.eval!==undefined&&typeof settings.eval!=='boolean')throw new TypeError('Invalid worker eval option')
        if(settings?.eval&&(execArgv.length!==1||!['--input-type=commonjs','--input-type=module'].includes(execArgv[0])))throw Object.assign(Error('Eval workers require an explicit input type'),{code:'ERR_UNSUPPORTED_OPERATION'})
        const commandArgs=settings?.eval?[...(execArgv[0]==='--input-type=module'?execArgv:[]),'-e',filename,...argv]:[...execArgv,filename,...argv]
        if(commandArgs.length>1024||commandArgs.some(arg=>typeof arg!=='string'||arg.includes('\0'))||JSON.stringify(commandArgs).length>1024*1024)throw Object.assign(Error('Invalid worker arguments'),{code:'EINVAL'})
        for(const name of ['stdout','stderr'])if(settings?.[name]!==undefined&&typeof settings[name]!=='boolean')throw new TypeError('Invalid worker '+name)
        if(settings?.dataURL!==undefined&&typeof settings.dataURL!=='boolean')throw new TypeError('Invalid worker data URL option')
        if(settings?.dataURL&&(settings.eval||!filename.startsWith('data:')))throw new TypeError('Invalid data URL worker')
        const workerSettings:SpawnOptions={cwd:settings?.cwd,env:settings?.env,stdio:['ignore',settings?.stdout?'pipe':'inherit',settings?.stderr?'pipe':'inherit']}
        let input:ProcessInput
        if(settings?.eval)input=prepareProcess('node',commandArgs,workerSettings,record)
        else{
          const workerOptions=prepareProcessOptions(workerSettings,record)
          validateExecution('',workerOptions)
          const entry=settings?.dataURL?filename:processPath(workerOptions.cwd!,filename)
          // Entry lookup belongs to the child. Constructor/launch errors stay
          // synchronous, while missing modules use the worker error channel.
          input=settings?.dataURL
            ?{code:`import ${JSON.stringify(entry)};`,loadModules:true,argv:['/usr/bin/browser-node',entry,...argv],execArgv:[...execArgv],options:workerOptions}
            :{code:'',entry,argv:['/usr/bin/browser-node',entry,...argv],execArgv:[...execArgv],options:workerOptions}
        }
        // Node exposes worker execArgv, not the internal bootstrap -e argument.
        Object.assign(input.options,workerExecutionLimits({maxBytes:input.options.maxBytes!,timeoutMs:input.options.timeoutMs!},workerMaxBytes))
        if(settings?.eval)input.execArgv=[...execArgv]
        const transferred=settings?.ports??[];processes.ports.validate(id,transferred)
        input.worker={threadId:0,data}
        value=sendResources(settings?.shared,settings?.modules,resources=>{
          let child:ReturnType<typeof processes.start>
          try{child=processes.start(id,input)}catch(error){
            if(options.diagnostics&&workerStartFailures++<8){
              const queued=engineAccess.pendingSnapshot()
              self.postMessage({type:'job-profile',value:{pid:id,phase:'worker-start-failure',at:performance.now(),ms:0,jobs:1,workerStartError:{name:error instanceof Error?error.name:'Error',message:String(error instanceof Error?error.message:error).slice(0,1024)},workerStartScheduling:{queued,sources:engineAccess.pendingSources(),ports:workerPoll.diagnosticSnapshot(queued.workers.map(group=>group.endpoint)),activeCheckBatch,checkBatches:checkBatches.slice(-4),checkpoint:schedulerCheckpoints.at(-1)}}})
              for(const trace of activeHostTaskTraces.values())self.postMessage({type:'host-task-scheduling',value:trace})
            }
            throw error
          }
          if(sharedSender)child.sharedStartup=resources[0]
          if(moduleSender)child.moduleStartup=resources[sharedSender?1:0]
          return child.pid
        })
        processes.ports.move(id,value as number,transferred)
        // The endpoint exists at construction, even though guest delivery waits
        // for online. Register before the next poll snapshot so online delivery
        // cannot accidentally defer this existing port for another whole turn.
        workerPoll.observe(value as number)
      }
      else if(method==='ipcSend'){
        const bytes=args[1]
        if(!Array.isArray(bytes)||bytes.length>1024*1024||!bytes.every(byte=>Number.isInteger(byte)&&byte>=0&&byte<=255))throw new TypeError('Invalid IPC bytes')
        value=processes.sendIPC(id,args[0],new Uint8Array(bytes))
      }
      else if(method==='ipcDisconnect')processes.disconnectIPC(id,args[0])
      else if(method==='ipcConnected')value=processes.connectedIPC(id,args[0])
      else if(method==='ipcRef')record.ipcRef=!!args[0]
      else if(method==='workerSend'){
        const bytes=args[1]
        if(!Array.isArray(bytes)||bytes.length>1024*1024||!bytes.every(byte=>Number.isInteger(byte)&&byte>=0&&byte<=255))throw new TypeError('Invalid worker message bytes')
        const send=(resources:Parameters<typeof processes.sendWorker>[4]=[])=>processes.sendWorker(id,args[0],new Uint8Array(bytes),args[2]??[],resources)
        value=sendResources(args[3],args[4],send)
        // Successful false means accepted with backpressure, so record it too.
        workerMessageTiming?.send(args[0],new Uint8Array(bytes))
      }
      else if(method==='routedPortPair')value=processes.ports.pair(id)
      else if(method==='routedPortCheck')processes.ports.validate(id,[args[0]])
      else if(method==='routedPortAck')processes.ports.ack(id,args[0],args[1])
      else if(method==='routedPortClose'){processes.ports.close(id,args[0]);referencedPorts.delete(args[0])}
      else if(method==='routedPortTake'){const delivery=processes.ports.takeDelivery(id,args[0]);value=delivery===null?null:{token:delivery.token,bytes:Array.from(delivery.bytes)}}
      else if(method==='routedPortSend'){
        const bytes=args[1]
        if(!Array.isArray(bytes)||bytes.length>1024*1024||!bytes.every(byte=>Number.isInteger(byte)&&byte>=0&&byte<=255))throw new TypeError('Invalid MessagePort bytes')
        const send=(resources:Parameters<typeof processes.ports.send>[4]=[])=>processes.ports.send(id,args[0],new Uint8Array(bytes),args[2]??[],resources)
        sendResources(args[3],args[4],send)
      }
      else if(method==='workerClose')processes.closeWorker(id,args[0])
      else if(method==='workerAck')processes.acknowledgeWorker(id,args[0],args[1])
      else if(method==='workerPortRef')record.workerRef=!!args[0]
      else if(method==='portRef'){
        if(!Number.isSafeInteger(args[0])||args[0]<1)throw new TypeError('Invalid message port identity')
        if(args[1]){
          if(!referencedPorts.has(args[0])&&referencedPorts.size>=512)throw Object.assign(Error('Referenced message port limit exceeded'),{code:'ERR_RESOURCE_LIMIT'})
          referencedPorts.add(args[0])
        }else referencedPorts.delete(args[0])
      }
      else if(method==='memoryUsage'){
        const usage=runtime.computeMemoryUsage()
        try{
          const stats=context.dump(usage) as {malloc_size:number;memory_used_size:number}
          value={heapTotal:stats.malloc_size,heapUsed:stats.memory_used_size}
        }finally{usage.dispose()}
      }
      else if(method==='cwd')value=record.cwd
      else if(method==='chdir')record.cwd=processDirectory(files!,args[0],record.cwd)
      else if(method==='kill')value=processes.kill(id,args[0],args[1])
      else if(method==='end')value=processes.endInput(id,args[0])
      else if(method==='ref'){processes.get(id,args[0]).ref=!!args[1]}
      else if(method==='forget')processes.forget(id,args[0])
      else if(method==='terminalState')value=record.terminal?{...record.terminal.size,raw:record.terminal.raw}:null
      else if(method==='terminalRaw'){
        if(!record.terminal)throw Object.assign(Error('Process has no terminal'),{code:'ERR_TTY_INIT_FAILED'})
        if(typeof args[0]!=='boolean')throw new TypeError('Expected raw mode boolean')
        record.terminal.setRawMode(args[0])
      }
      else if(method==='inputRef'){record.stdinRef=!!args[0]}
      else throw Error('Unknown process operation')
      return context.newString(JSON.stringify(value??null))
    })
    expose('__processNext',handle=>{
      const key=context.getNumber(handle)
      return networkPromise(()=>processes.next(id,key),0,value=>{
        const event=value as Awaited<ReturnType<typeof processes.next>>
        if(event===null)return context.null.dup()
        const result=context.newObject()
        try{
          const fields=event.type==='exit'?{type:event.type,code:event.code,signal:event.signal}:event.type==='error'?{type:event.type,error:event.error}:{type:event.type}
          for(const [name,value] of Object.entries(fields)){
            const field=value===null?context.null.dup():typeof value==='number'?context.newNumber(value):typeof value==='string'?context.newString(value):context.newString(JSON.stringify(value))
            try{context.setProp(result,name,field)}finally{field.dispose()}
          }
          if(event.type==='stdout'||event.type==='stderr'){
            // Copy only the owned chunk, never expose the host's backing store.
            const bytes=context.newArrayBuffer(event.bytes.slice().buffer)
            try{context.setProp(result,'bytes',bytes)}finally{bytes.dispose()}
          }
          return result
        }catch(error){result.dispose();throw error}
      },undefined,'process-event')
    })
    expose('__processIPCNext',handle=>{
      const key=context.getNumber(handle)
      return networkPromise(async()=>{const bytes=await processes.receiveIPC(id,key);return bytes===null?null:Array.from(bytes)})
    })
    const deliveryResources=(scope:string,endpoint:number,token:number)=>scope==='worker'?processes.workerResources(id,endpoint,token):scope==='port'?processes.ports.resources(id,endpoint,token):scope==='data'&&endpoint===0&&token===0?[record.sharedStartup,record.moduleStartup].filter((resource):resource is MessageResource=>resource!==undefined):[]
    if(moduleSender){
      expose('__moduleRetain',value=>{
        return context.newNumber(retainModuleSource(context,value,moduleSender))
      })
      expose('__moduleRelease',ids=>{moduleSender.release(JSON.parse(context.getString(ids)));return context.undefined})
      expose('__moduleFinishData',()=>{processes.finishWorkerData(record);return context.undefined})
      expose('__moduleAdopt',(scope,endpoint,token,moduleId)=>{
        const bytes=moduleDelivery(deliveryResources(context.getString(scope),context.getNumber(endpoint),context.getNumber(token))).adopt(context.getNumber(moduleId))
        return context.newArrayBuffer(bytes.buffer as ArrayBuffer)
      })
    }
    if(sharedSender){
      expose('__sharedRetain',value=>context.newNumber(sharedSender.retain(context as SharedContext,value)))
      if(options.guestWasm)expose('__sharedRetainMemory',value=>context.newNumber(sharedSender.retainMemory(context as SharedContext,value)))
      expose('__sharedRelease',ids=>{sharedSender.release(JSON.parse(context.getString(ids)));return context.undefined})
      expose('__sharedFinishData',()=>{processes.finishWorkerData(record);return context.undefined})
      expose('__sharedAdopt',(scopeValue,endpointValue,tokenValue,idValue)=>{
        const scope=context.getString(scopeValue),endpoint=context.getNumber(endpointValue),token=context.getNumber(tokenValue),codecId=context.getNumber(idValue)
        const resources=deliveryResources(scope,endpoint,token)
        return context.unwrapResult(sharedDelivery(resources).adopt(codecId,context))
      })
    }
    expose('__workerNext',handle=>{
      const key=context.getNumber(handle)
      workerPoll.observe(key)
      let settled:(()=>void)|undefined
      return networkPromise(async()=>{const delivery=await processes.receiveWorkerDelivery(id,key);if(delivery){settled=workerMessageTiming?.receive(key,delivery);pendingWorkerBytes.set(key,{token:delivery.token,bytes:delivery.bytes})}return delivery===null?null:{token:delivery.token}},0,value=>{
        // This is host-to-guest promise settlement, before guest .then handlers.
        if(value!==null)workerPoll.settled(key,(value as {token:number}).token)
        settled?.();return context.newString(JSON.stringify(value??null))
      },key,'worker-message')
    })
    expose('__workerBytes',(handleValue,tokenValue)=>{
      const key=context.getNumber(handleValue),token=context.getNumber(tokenValue),delivery=pendingWorkerBytes.get(key)
      if(!delivery||delivery.token!==token)throw Object.assign(Error('Worker message bytes are unavailable'),{code:'ERR_INVALID_STATE'})
      pendingWorkerBytes.delete(key)
      return context.newArrayBuffer(delivery.bytes.slice().buffer)
    })
    expose('__routedPortNext',handle=>{
      const key=context.getNumber(handle)
      return networkPromise(async()=>{const value=await processes.ports.receive(id,key);return value===null?null:{token:value.token,bytes:Array.from(value.bytes)}},0,undefined,undefined,'routed-port')
    })
    expose('__stdinRead',(lengthValue,onceValue)=>{
      const length=context.getNumber(lengthValue)
      const once=!!context.dump(onceValue)
      if(!Number.isSafeInteger(length)||length<0||length>65536)throw Error('Invalid stdin read length')
      if(!once)record.stdinRef=true
      return networkPromise(async()=>{
        if(once)pendingInputReads++
        try{const bytes=await record.stdin.read(id,length);if(!once&&bytes===null)record.stdinRef=false;return bytes}
        finally{if(once)pendingInputReads--}
      },0,value=>value===null?context.null.dup():context.newArrayBuffer(Uint8Array.from(value as ArrayLike<number>).buffer))
    })
    expose('__processWrite',(handle,value)=>{
      const key=context.getNumber(handle),borrowed=context.getArrayBuffer(value)
      let data:Uint8Array
      try{
        if(borrowed.value.byteLength>65536)throw Error('Stdin write exceeds transport limit')
        data=borrowed.value.slice()
      }finally{borrowed.dispose()}
      return networkPromise(()=>processes.writeInput(id,key,data),data.length)
    })
    expose('__workerSend',(handle,value,portsValue,sharedValue,modulesValue)=>{
      const key=context.getNumber(handle),borrowed=context.getArrayBuffer(value)
      let data:Uint8Array
      try{
        if(borrowed.value.byteLength>4*1024*1024)throw Object.assign(Error('Worker message exceeds the byte limit'),{code:'ERR_RESOURCE_LIMIT'})
        data=borrowed.value.slice()
      }finally{borrowed.dispose()}
      const ports=JSON.parse(context.getString(portsValue)),shared=JSON.parse(context.getString(sharedValue)),modules=JSON.parse(context.getString(modulesValue))
      if(!Array.isArray(ports)||!Array.isArray(shared)||!Array.isArray(modules))throw new TypeError('Invalid worker message resources')
      const send=(resources:Parameters<typeof processes.sendWorker>[4]=[])=>processes.sendWorker(id,key,data,ports,resources)
      const writable=sendResources(shared,modules,send)
      workerMessageTiming?.send(key,data)
      return context.newNumber(writable?1:0)
    })
    expose('__netWrite',(handle,value)=>{
      const key=context.getNumber(handle),borrowed=context.getArrayBuffer(value)
      let data:Uint8Array
      try{
        if(borrowed.value.byteLength>65536)throw Error('Socket write exceeds transport limit')
        // The network owns this copy after the borrowed QuickJS view is released.
        data=borrowed.value.slice()
      }finally{borrowed.dispose()}
      return networkPromise(()=>network.write(id,key,data),data.length)
    })
    // Capture the native realm factory before removing bootstrap capabilities.
    // Child contexts and their compiler handles are owned by QuickJS GC.
    const contextFactory=context.getProp(context.global,'__qjsCreateContext')
    try{context.setProp(context.global,'__createVMContext',contextFactory)}finally{contextFactory.dispose()}
    context.unwrapResult(context.evalCode(alsBootstrap)).dispose()
    // Aggregate native operation time without changing job batches or wrapping
    // every WASM import. Times include guest callbacks, not just WASM compute.
    if(options.diagnostics&&!options.profileJobs&&options.guestWasm)expose('__measureWasm',(opValue,startValue)=>{
      const op=context.getNumber(opValue)
      if(op===-1){if(context.getNumber(startValue)===0)wasmModuleTiming?.begin();return context.newNumber(performance.now())}
      if(op===0)wasmModuleTiming?.end()
      const total=wasmTotals.get(op)??{ms:0,calls:0}
      total.ms+=performance.now()-context.getNumber(startValue);total.calls++
      wasmTotals.set(op,total)
      return context.undefined
    })
    if(options.profileJobs&&options.guestWasm)expose('__profileWasm',(opValue,startValue,importsMsValue,importsValue)=>{
      const op=context.getNumber(opValue)
      if(op===-1)return context.newNumber(performance.now())
      profile(op===0?'wasm-compile':op===2?'wasm-instantiate':op===4?'wasm-import':'wasm-call',context.getNumber(startValue),0,
        importsMsValue?context.getNumber(importsMsValue):undefined,importsValue?context.getNumber(importsValue):undefined)
      return context.undefined
    })
    expose('__clock',()=>context.newNumber(performance.now()-clockStart))
    expose('__randomBytes',sizeValue=>{
      const size=context.getNumber(sizeValue)
      if(!Number.isSafeInteger(size)||size<0||size>65536)throw Object.assign(Error('Invalid random byte count'),{code:'ERR_OUT_OF_RANGE'})
      if(randomBytesUsed+size>4*1024*1024)throw Object.assign(Error('Random byte quota exceeded'),{code:'ERR_RESOURCE_LIMIT'})
      if(!globalThis.crypto?.getRandomValues)throw Error('Browser secure randomness is unavailable')
      randomBytesUsed+=size
      return context.newString(JSON.stringify(Array.from(crypto.getRandomValues(new Uint8Array(size)))))
    })
    expose('__descriptorCall',(methodValue,argsValue)=>{
      const method=context.getString(methodValue),serialized=context.getString(argsValue)
      if(serialized.length>1024*1024)throw Object.assign(Error('Descriptor request is too large'),{code:'ERR_RESOURCE_LIMIT'})
      const args=JSON.parse(serialized)
      if(!Array.isArray(args)||args.length>4)throw new Error('Invalid descriptor request')
      const fd=args[0]
      let result:unknown
      switch(method){
        case 'open':
          if(typeof fd!=='string'||!['string','number'].includes(typeof args[1]))throw new TypeError('Invalid open arguments')
          result=descriptors!.open(id,processPath(record.cwd,fd),args[1],options.writable!==false,args[2]);break
        case 'read':
          if(!Number.isSafeInteger(args[1])||args[1]<0||args[1]>65536)throw Object.assign(Error('Invalid descriptor read length'),{code:'EINVAL'})
          result={bytes:Array.from(descriptors!.read(id,fd,args[1],args[2]??null))};break
        case 'write':{
          const bytes=args[1]
          if(!Array.isArray(bytes)||bytes.length>65536||!bytes.every(value=>Number.isInteger(value)&&value>=0&&value<=255))throw Object.assign(Error('Invalid descriptor write bytes'),{code:'EINVAL'})
          result=descriptors!.write(id,fd,new Uint8Array(bytes),args[2]??null);break
        }
        case 'stat':result=descriptors!.stat(id,fd);break
        case 'truncate':result=descriptors!.truncate(id,fd,args[1]??0);break
        case 'close':result=descriptors!.close(id,fd);break
        default:throw Object.assign(Error('Unsupported descriptor operation'),{code:'ENOTSUP'})
      }
      return context.newString(JSON.stringify(result??null))
    })
    expose('__file',(methodValue,argsValue)=>{
      const before=diagnostics?performance.now():0
      if(diagnostics)diagnostics.fileCalls++
      try{
      const method=context.getString(methodValue),args=JSON.parse(context.getString(argsValue))
      if(method==='writeFile'){
        const data=args[1]
        if(typeof data==='string')args[1]=new TextEncoder().encode(data)
        else if(Array.isArray(data?.bytes)&&data.bytes.every((x:unknown)=>typeof x==='number'&&Number.isInteger(x)&&x>=0&&x<=255))args[1]=new Uint8Array(data.bytes)
        else throw Error('Invalid file bytes')
      }
      const result=fileCallSync(files!,options.writable!==false,method,processFileArguments(record.cwd,method,args))
      if(result instanceof Uint8Array)return context.newArrayBuffer(result.buffer.slice(result.byteOffset,result.byteOffset+result.byteLength))
      return context.newString(JSON.stringify(result??null))
      }finally{if(diagnostics)diagnostics.fileCallMs+=performance.now()-before}
    })
    expose('__print',(levelValue,textValue)=>{
      const level=context.getString(levelValue),text=context.getString(textValue)+'\n'
      reserveOutput(level==='error'||level==='warn'?2:1,new TextEncoder().encode(text).length)
      emitOutput(level,outputDecoders.get(level==='error'||level==='warn'?2:1)!.decode(new TextEncoder().encode(text),{stream:true}))
    })
    expose('__writeOutput',(fdValue,bytesValue)=>{
      const fd=context.getNumber(fdValue),serialized=context.getString(bytesValue)
      if(serialized.length>4*1024*1024+2)throw Object.assign(Error('Output quota exceeded'),{code:'ERR_RESOURCE_LIMIT'})
      const values=JSON.parse(serialized)
      if(!outputDecoders.has(fd)||!Array.isArray(values)||!values.every(x=>Number.isInteger(x)&&x>=0&&x<=255))throw Error('Invalid process output')
      reserveOutput(fd,values.length)
      const bytes=new Uint8Array(values)
      emitOutput(fd===2?'error':'log',outputDecoders.get(fd)!.decode(bytes,{stream:true}),bytes)
    })
    expose('__writePipeOutput',(fdValue,bytesValue)=>{
      const fd=context.getNumber(fdValue)
      if((fd!==1&&fd!==2)||record.owner===0||record.stdio[fd]!=='pipe')throw Error('Expected a child output pipe')
      const borrowed=context.getArrayBuffer(bytesValue)
      let bytes:Uint8Array
      try{
        if(borrowed.value.byteLength>65536)throw Error('Output write exceeds transport limit')
        bytes=borrowed.value.slice()
      }finally{borrowed.dispose()}
      return networkPromise(async()=>{
        pendingOutputWrites++
        try{await processes.writeOutput(record,{type:fd===1?'stdout':'stderr',bytes})}
        finally{pendingOutputWrites--}
      },bytes.length)
    })
    expose('__reportError',value=>{callbackFailure=context.getString(value);scheduler.wake()})
    expose('__watchOpen',(pathValue,recursiveValue,refValue)=>{
      if(watchers.size>=128)throw Error('Too many filesystem watchers')
      const path=files!.realpathSync(processPath(record.cwd,context.getString(pathValue)))
      const stat=fileCallSync(files!,false,'stat',[path]) as {kind:string}
      const key=++watchId
      watchers.set(key,{path,directory:stat.kind==='directory',recursive:!!context.dump(recursiveValue),ref:!!context.dump(refValue),queue:[]})
      return context.newNumber(key)
    })
    expose('__watchNext',value=>{
      const watcher=watchers.get(context.getNumber(value))
      if(!watcher)throw Error('Filesystem watcher is closed')
      if(watcher.pending)throw Error('Filesystem watcher already has a pending read')
      watcher.pending=context.newPromise()
      queueMicrotask(flushWatchers)
      return watcher.pending.handle.dup()
    })
    expose('__watchClose',value=>{
      const key=context.getNumber(value),watcher=watchers.get(key)
      if(watcher){
        watchers.delete(key)
        if(watcher.pending){watcher.pending.resolve(context.null);watcher.pending.dispose()}
      }
    })
    expose('__watchRef',(value,ref)=>{const watcher=watchers.get(context.getNumber(value));if(watcher)watcher.ref=!!context.dump(ref)})
    expose('__timer',delay=>{
      if(timers.size>=128)throw Error('Too many pending timers')
      const key=++timerId,deferred=context.newPromise()
      const handle=context.newNumber(key);context.setProp(deferred.handle,'timerId',handle);handle.dispose()
      const timer=setTimeout(()=>complete(()=>{
        if(!timers.has(key))return
        timers.delete(key);deferred.resolve();deferred.dispose();scheduler.wake()
      },undefined,'timer'),context.getNumber(delay))
      timers.set(key,{timer,deferred,ref:true});return deferred.handle.dup()
    })
    expose('__cancelTimer',value=>{
      const key=context.getNumber(value),entry=timers.get(key)
      if(entry){clearTimeout(entry.timer);entry.deferred.dispose();timers.delete(key)}
    })
    expose('__timerRef',(value,ref)=>{const entry=timers.get(context.getNumber(value));if(entry)entry.ref=!!context.dump(ref)})
    expose('__immediate',()=>{
      if(immediates.size>=128)throw Error(`Too many pending immediates (pending=${immediates.size}, hostCompletions=${engineAccess.pending}, limit=128)`)
      const key=++timerId,deferred=context.newPromise(),handle=context.newNumber(key)
      context.setProp(deferred.handle,'immediateId',handle);handle.dispose()
      immediates.set(key,{deferred,ref:true});return deferred.handle.dup()
    })
    expose('__cancelImmediate',value=>{
      const key=context.getNumber(value),entry=immediates.get(key)
      if(entry){immediates.delete(key);entry.deferred.dispose()}
    })
    expose('__immediateRef',(value,ref)=>{const entry=immediates.get(context.getNumber(value));if(entry)entry.ref=!!context.dump(ref)})
    context.unwrapResult(context.evalCode(`(()=>{
      globalThis.global=globalThis;
      const file=__file,print=__print,writeOutput=__writeOutput,timer=__timer,cancel=__cancelTimer,timerRef=__timerRef,report=__reportError,ALS=__engineAsyncLocalStorage,clock=__clock,randomBytes=__randomBytes,compileScript=globalThis.__qjsCompileScript,createContext=globalThis.__createVMContext;
      delete globalThis.__qjsCompileScript;
      delete globalThis.__createVMContext;
      const vmModules=globalThis.vmNative;delete globalThis.vmNative;
      const watchOpen=__watchOpen,watchNext=__watchNext,watchClose=__watchClose,watchRef=__watchRef;
      const immediate=__immediate,cancelImmediate=__cancelImmediate,immediateRef=__immediateRef;
      const netCall=__netCall,netNext=__netNext,netWrite=__netWrite,dgramCall=__dgramCall,dgramNext=__dgramNext;
      const tlsCall=__tlsCall;delete globalThis.__tlsCall;
      const http2Call=__http2Call;delete globalThis.__http2Call;
      const descriptorCall=__descriptorCall;delete globalThis.__descriptorCall;
      const filesystemTask=__filesystemTask;delete globalThis.__filesystemTask;
      const processCall=__processCall,processNext=__processNext,processIPCNext=__processIPCNext,workerNext=__workerNext,workerBytes=__workerBytes,processWrite=__processWrite,workerSend=__workerSend,stdinRead=__stdinRead;
      const routedPortNext=__routedPortNext;delete globalThis.__routedPortNext;
      const writePipeOutput=__writePipeOutput;delete globalThis.__writePipeOutput;
      delete globalThis.__processCall;delete globalThis.__processNext;delete globalThis.__processIPCNext;delete globalThis.__workerNext;delete globalThis.__workerBytes;delete globalThis.__processWrite;delete globalThis.__workerSend;delete globalThis.__stdinRead;
      delete globalThis.__netCall;delete globalThis.__netNext;delete globalThis.__netWrite;delete globalThis.__dgramCall;delete globalThis.__dgramNext;
      for(const key of ['__file','__print','__writeOutput','__timer','__cancelTimer','__timerRef','__immediate','__cancelImmediate','__immediateRef','__reportError','__watchOpen','__watchNext','__watchClose','__watchRef','__engineAsyncLocalStorage','__clock','__randomBytes'])delete globalThis[key];
      const reportError=error=>report(error instanceof Error?error.message+'\\n'+error.stack:String(error));
      const encode=v=>typeof v==='string'?v:v instanceof Uint8Array?{bytes:Array.from(v)}:(()=>{throw Error('Expected string or Uint8Array')})();
      const call=(method,args)=>{const value=file(method,JSON.stringify(args));return typeof value==='string'?JSON.parse(value):new Uint8Array(value)};
      const fsSync={
        readFile:(...args)=>call('readFile',args),
        writeFile:(path,value,options)=>call('writeFile',[path,encode(value),options]),
        readdir:(...args)=>call('readdir',args),
        exists:path=>call('exists',[path]),realpath:path=>call('realpath',[path]),
        access:(...args)=>call('access',args),
        stat:path=>{const v=call('stat',[path]);return {...v,isFile:()=>v.kind==='file',isDirectory:()=>v.kind==='directory'}}
      };
      for(const method of ['mkdir','rmdir','rm','unlink','rename','copyFile','truncate','chmod','symlink','readlink','lstat'])fsSync[method]=(...args)=>call(method,args);
      const fs=Object.fromEntries(Object.entries(fsSync).map(([name,fn])=>[name,async(...args)=>{await filesystemTask();return fn(...args)}]));
      globalThis.__webContainerHost={fs,fsSync,AsyncLocalStorage:ALS,env:${JSON.stringify(record.input.options.env??{})},argv:${JSON.stringify(record.input.argv)},execArgv:${JSON.stringify(record.input.execArgv??[])},pid:${id},ppid:${record.owner},now:clock,randomBytes,timeOrigin:${timeOrigin},reportError,watchOpen,watchNext,watchClose,watchRef,compileScript,createContext,vmModules};
      if(typeof globalThis.__qjsEncodeUTF8==='function')globalThis.__webContainerHost.encodeUTF8=globalThis.__qjsEncodeUTF8;
      delete globalThis.__qjsEncodeUTF8;
      if(typeof globalThis.__qjsUTF8ByteLength==='function')globalThis.__webContainerHost.utf8ByteLength=globalThis.__qjsUTF8ByteLength;
      if(typeof globalThis.__qjsWriteUTF8==='function')globalThis.__webContainerHost.writeUTF8=globalThis.__qjsWriteUTF8;
      delete globalThis.__qjsUTF8ByteLength;delete globalThis.__qjsWriteUTF8;
      globalThis.__webContainerHost.filesystemTask=filesystemTask;
      globalThis.__webContainerHost.ipcMode=${JSON.stringify(record.input.ipcMode??null)};
      ${options.guestWasm?`const moduleRetain=__moduleRetain,moduleRelease=__moduleRelease,moduleAdopt=__moduleAdopt,moduleFinishData=__moduleFinishData;
      delete globalThis.__moduleRetain;delete globalThis.__moduleRelease;delete globalThis.__moduleAdopt;delete globalThis.__moduleFinishData;
      globalThis.__webContainerHost.moduleResources={retain:moduleRetain,release:ids=>moduleRelease(JSON.stringify(ids)),adopt:moduleAdopt,finishWorkerData:moduleFinishData};`:''}
      ${experimentalFibers?`const sharedRetain=__sharedRetain,sharedRelease=__sharedRelease,sharedAdopt=__sharedAdopt,sharedFinishData=__sharedFinishData;
      delete globalThis.__sharedRetain;delete globalThis.__sharedRelease;delete globalThis.__sharedAdopt;delete globalThis.__sharedFinishData;
      globalThis.__webContainerHost.shared={retain:sharedRetain,release:ids=>sharedRelease(JSON.stringify(ids)),adopt:sharedAdopt,finishWorkerData:sharedFinishData};`:''}
      ${experimentalFibers&&options.guestWasm?`globalThis.__webContainerHost.shared.retainMemory=__sharedRetainMemory;delete globalThis.__sharedRetainMemory;`:''}
      globalThis.__webContainerHost.worker=${JSON.stringify(record.input.worker??null)};
      globalThis.__webContainerHost.proc={call:(method,...args)=>JSON.parse(processCall(method,JSON.stringify(args))),next:pid=>processNext(pid),ipcNext:pid=>processIPCNext(pid).then(JSON.parse),write:(pid,bytes)=>processWrite(pid,bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)),workerSend:(pid,bytes,ports,shared,modules)=>!!workerSend(pid,bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),JSON.stringify(ports),JSON.stringify(shared),JSON.stringify(modules)),readInput:(length=65536,once=false)=>stdinRead(length,once).then(value=>value===null?null:new Uint8Array(value))};
      globalThis.__webContainerHost.proc.workerNext=pid=>workerNext(pid).then(value=>{const delivery=JSON.parse(value);if(delivery!==null)delivery.bytes=new Uint8Array(workerBytes(pid,delivery.token));return delivery});
      globalThis.__webContainerHost.proc.portNext=key=>routedPortNext(key).then(JSON.parse);
      globalThis.__webContainerHost.net={call:(method,...args)=>JSON.parse(netCall(method,JSON.stringify(args))),next:key=>netNext(key).then(JSON.parse),write:(key,bytes)=>{
        if(!(bytes instanceof Uint8Array))throw new TypeError('Expected socket bytes');
        return netWrite(key,bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
      }};
      globalThis.__webContainerHost.dgram={call:(method,...args)=>JSON.parse(dgramCall(method,JSON.stringify(args))),next:key=>dgramNext(key).then(JSON.parse)};
      globalThis.__webContainerHost.tls={call:(method,...args)=>JSON.parse(tlsCall(method,JSON.stringify(args)))};
      globalThis.__webContainerHost.http2={call:(method,...args)=>JSON.parse(http2Call(method,JSON.stringify(args)))};
      globalThis.__webContainerHost.descriptors={call:(method,...args)=>JSON.parse(descriptorCall(method,JSON.stringify(args)))};
      globalThis.__webContainerHost.writeOutput=(fd,bytes)=>{
        if(!(bytes instanceof Uint8Array))throw new TypeError('Expected output bytes');
        if(bytes.byteLength>1048576)throw Object.assign(Error('Output quota exceeded'),{code:'ERR_RESOURCE_LIMIT'});
        for(let offset=0;offset<bytes.length;offset+=16384)writeOutput(fd,JSON.stringify(Array.from(bytes.subarray(offset,offset+16384))));
      };
      globalThis.__webContainerHost.writeOutputAsync=(fd,bytes)=>{
        if(!${JSON.stringify(record.owner!==0)}||${JSON.stringify(record.stdio)}[fd]!=='pipe')return globalThis.__webContainerHost.writeOutput(fd,bytes);
        if(!(bytes instanceof Uint8Array))throw new TypeError('Expected output bytes');
        return (async()=>{for(let offset=0;offset<bytes.length;offset+=16384){const chunk=bytes.subarray(offset,offset+16384);await writePipeOutput(fd,chunk.buffer.slice(chunk.byteOffset,chunk.byteOffset+chunk.byteLength))}})();
      };
      const formatConsoleError=(${formatGuestConsoleError.toString()});
      globalThis.console=Object.fromEntries(['log','info','warn','error','debug'].map(level=>[level,(...args)=>print(level,args.map(x=>typeof x==='string'?x:x instanceof Error?formatConsoleError(x):JSON.stringify(x)).join(' '))]));
      console.assert=(condition,...args)=>{if(!condition)console.error('Assertion failed'+(args.length?': '+args.join(' '):''))};
      const handles=new Map();
      class Timeout {
        constructor(callback,delay,args,repeat){this.callback=callback;this.invoke=ALS.bind(callback);this.delay=delay;this.args=args;this.repeat=repeat;this.referenced=true;this.closed=false;this.arm()}
        arm(){this.active=true;const p=timer(this.delay);this.hostId=p.timerId;this.id??=p.timerId;handles.set(this.id,this);timerRef(this.hostId,this.referenced);
          p.then(()=>{
            if(this.closed||this.hostId!==p.timerId)return;
            try{globalThis[Symbol.for('web-container:task-queue')].task(this.invoke,this,this.args)}catch(error){reportError(error)}
            if(this.hostId!==p.timerId)return;
            if(this.repeat&&!this.closed)this.arm();else{this.active=false;handles.delete(this.id)}
          });
        }
        ref(){this.referenced=true;timerRef(this.hostId,true);return this}
        unref(){this.referenced=false;timerRef(this.hostId,false);return this}
        hasRef(){return this.referenced}
        refresh(){if(this.closed)return this;if(!this.active)this.invoke=ALS.bind(this.callback);cancel(this.hostId);handles.delete(this.id);this.arm();return this}
        close(){this.closed=true;this.active=false;cancel(this.hostId);handles.delete(this.id);return this}
        [Symbol.toPrimitive](){return this.id}
      }
      const schedule=(repeat,callback,delay=1,...args)=>{
        if(typeof callback!=='function')throw new TypeError('Expected callback');
        delay=Number(delay);if(!Number.isFinite(delay)||delay<1||delay>2147483647)delay=1;
        return new Timeout(callback,Math.trunc(delay),args,repeat);
      };
      globalThis.setTimeout=(...args)=>schedule(false,...args);
      globalThis.setInterval=(...args)=>schedule(true,...args);
      globalThis.clearTimeout=globalThis.clearInterval=id=>{(id instanceof Timeout?id:handles.get(Number(id)))?.close()};
      class Immediate {
        constructor(callback,args){
          const invoke=ALS.bind(callback),pending=immediate();this.id=pending.immediateId;this.closed=false;this.referenced=true;
          pending.then(()=>{
            if(this.closed)return;
            this.closed=true;this.referenced=false;
            try{globalThis[Symbol.for('web-container:task-queue')].task(invoke,this,args)}catch(error){reportError(error)}
          });
        }
        ref(){if(!this.closed){this.referenced=true;immediateRef(this.id,true)}return this}
        unref(){if(!this.closed){this.referenced=false;immediateRef(this.id,false)}return this}
        hasRef(){return this.referenced}
        [Symbol.dispose](){clearImmediate(this)}
      }
      globalThis.setImmediate=(callback,...args)=>{
        if(typeof callback!=='function')throw Object.assign(new TypeError('Expected callback'),{code:'ERR_INVALID_ARG_TYPE'});
        return new Immediate(callback,args);
      };
      globalThis.clearImmediate=handle=>{if(handle instanceof Immediate&&!handle.closed){handle.closed=true;handle.referenced=false;cancelImmediate(handle.id)}};
      globalThis.queueMicrotask=fn=>{if(typeof fn!=='function')throw new TypeError('Expected callback');Promise.resolve().then(()=>{try{fn()}catch(error){reportError(error)}})};
    })()`)).dispose()
    // The WASM bootstrap attaches its private Memory clone hooks to the host
    markBootstrap('host-bridge-ready')
    // bridge, so initialize it after that bridge and before guest modules.
    if(options.guestWasm)context.unwrapResult(context.evalCode(wasmBootstrap)).dispose()
    markBootstrap('wasm-bootstrap-ready')
    if(options.webAPIs){
      webSource??=fetch(runtimeAssetURL('vm-web-apis/globals.js',assetBaseURL)).then(r=>{if(!r.ok)throw Error('Missing guest Web APIs');return r.text()}).catch(e=>{webSource=undefined;throw e})
      const webAPISource=await webSource
      markBootstrap('web-api-source-ready')
      if(experimentalFibers)initializeTrustedWebAPIs(engine,context,webAPISource)
      else context.unwrapResult(context.evalCode(webAPISource,'web-apis.js')).dispose()
      markBootstrap('web-api-evaluated')
      if(options.workspaceFetch||externalPolicy){
        let externalRequests=0,externalBytes=0
        const externalRead=externalPolicy?(async(input:string,method:string,headers:Record<string,string>)=>{
          if(input.length>16384)throw new TypeError('External fetch URL is too long')
          const url=new URL(input)
          if(url.username||url.password||!externalPolicy.allowedOrigins.has(url.origin))throw new TypeError('External fetch origin is not allowed')
          if(method!=='GET'&&method!=='HEAD')throw new TypeError('External fetch only supports GET and HEAD')
          const allowedHeaders:Record<string,string>={}
          for(const [name,value] of Object.entries(headers)){
            if(name.toLowerCase()!=='accept'||typeof value!=='string'||value.length>4096)throw new TypeError('External fetch request header is not allowed')
            allowedHeaders.accept=value
          }
          if(++externalRequests>externalPolicy.maxRequests)throw Object.assign(Error('External fetch request quota exceeded'),{code:'ERR_RESOURCE_LIMIT'})
          const controller=new AbortController()
          const abort=()=>controller.abort(record.controller.signal.reason)
          record.controller.signal.addEventListener('abort',abort,{once:true})
          const timer=setTimeout(()=>controller.abort(Error('External fetch timed out')),Math.min(30000,Math.max(1,budget.waitTimeout??30000)))
          try{
            const response=await fetch(url,{method,headers:allowedHeaders,credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',cache:'no-store',signal:controller.signal})
            const headers=Object.fromEntries(response.headers)
            if(method==='HEAD')return {metadata:{url:response.url,status:response.status,statusText:response.statusText,headers},bytes:null}
            const limit=Math.min(externalPolicy.maxResponseBytes,externalPolicy.maxTotalBytes-externalBytes)
            const declared=Number(response.headers.get('content-length'))
            if(Number.isFinite(declared)&&declared>limit){await response.body?.cancel();throw Object.assign(Error('External fetch response byte quota exceeded'),{code:'ERR_RESOURCE_LIMIT'})}
            const chunks:Uint8Array[]=[],reader=response.body?.getReader();let size=0
            if(reader)for(;;){
              const part=await reader.read()
              if(part.done)break
              size+=part.value.byteLength
              if(size>limit){await reader.cancel();throw Object.assign(Error('External fetch response byte quota exceeded'),{code:'ERR_RESOURCE_LIMIT'})}
              chunks.push(part.value)
            }
            const bytes=new Uint8Array(size);let offset=0
            for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}
            externalBytes+=size
            return {metadata:{url:response.url,status:response.status,statusText:response.statusText,headers},bytes}
          }finally{clearTimeout(timer);record.controller.signal.removeEventListener('abort',abort)}
        }):undefined
        if(externalRead)expose('__readExternalAsset',(urlValue,methodValue,headersValue)=>{
          const json=context.getString(headersValue)
          if(json.length>16384)throw new TypeError('External fetch headers are too large')
          const headers=JSON.parse(json)
          if(!headers||typeof headers!=='object'||Array.isArray(headers)||Object.values(headers).some(value=>typeof value!=='string'))throw new TypeError('Invalid external fetch headers')
          const url=context.getString(urlValue),method=context.getString(methodValue)
          return networkPromise(()=>externalRead(url,method,headers as Record<string,string>),0,value=>{
          const asset=value as {metadata:unknown;bytes:Uint8Array|null},result=context.newObject()
          try{
            const metadata=context.newString(JSON.stringify(asset.metadata))
            try{context.setProp(result,'metadata',metadata)}finally{metadata.dispose()}
            const bytes=asset.bytes===null?context.null.dup():context.newArrayBuffer(asset.bytes.buffer.slice(asset.bytes.byteOffset,asset.bytes.byteOffset+asset.bytes.byteLength))
            try{context.setProp(result,'bytes',bytes)}finally{bytes.dispose()}
            return result
          }catch(error){result.dispose();throw error}
          })
        })
        if(options.workspaceFetch){
        const read=createWorkspaceAssetReader(files!)
        expose('__readWorkspaceAsset',(url,method)=>{
          const asset=read(context.getString(url),context.getString(method)),value=context.newObject()
          try{
            const metadata=context.newString(JSON.stringify(asset.metadata))
            try{context.setProp(value,'metadata',metadata)}finally{metadata.dispose()}
            const bytes=asset.bytes===null?context.null.dup():context.newArrayBuffer(asset.bytes.buffer)
            try{context.setProp(value,'bytes',bytes)}finally{bytes.dispose()}
            return value
          }catch(error){value.dispose();throw error}
        })
        }
        context.unwrapResult(context.evalCode(workspaceFetchBootstrap,'workspace-fetch.js')).dispose()
      }
    }
    markBootstrap('web-apis-ready')
    let workerOnline=false
    const emitWorkerOnline=()=>{if(record.input.worker&&!workerOnline){processes.emit(record,{type:'online'});workerOnline=true}}
    if(options.entry!==undefined||options.loadModules){
      if(options.entry!==undefined&&(typeof options.entry!=='string'||!options.entry.startsWith('/')))throw Error('Expected an absolute module entry path')
      moduleArtifact??=fetch(runtimeAssetURL('kernel-runtime/builtins.json',assetBaseURL)).then(async response=>{
        if(!response.ok)throw Error('Missing runtime builtins, run npm run build:kernel-builtins')
        return response.json()
      }).catch(error=>{moduleArtifact=undefined;throw error})
      markBootstrap('builtin-artifact-requested')
      const artifact=await moduleArtifact
      markBootstrap('builtin-artifact-ready')
      if(artifact.version!==2)throw Error('Unsupported runtime builtin format')
      const builtinAssetBytes=new Map<string,Uint8Array>(await Promise.all(Object.entries(artifact.assets??{}).map(async([name,asset])=>{
        if(!asset||typeof asset.path!=='string'||!/^kernel-runtime\/[A-Za-z0-9._-]+$/.test(asset.path))throw Error(`Invalid builtin asset: ${name}`)
        const response=await fetch(runtimeAssetURL(asset.path,assetBaseURL))
        if(!response.ok)throw Error(`Missing builtin asset: ${name}`)
        return [name,new Uint8Array(await response.arrayBuffer())] as const
      })))
      expose('__readBuiltinAsset',nameHandle=>{
        const name=context.getString(nameHandle),bytes=builtinAssetBytes.get(name)
        if(!bytes)throw Object.assign(Error(`Unknown builtin asset: ${name}`),{code:'ENOENT'})
        return context.newArrayBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength))
      })
      const resolver=new ModuleResolver(files!,new Set(Object.keys(artifact.modules)))
      // Capture and validate installed bytes before any guest module executes.
      // Compilation below checks both current bytes and loader-hook output again.
      const parserBindings=new Map<string,Awaited<ReturnType<typeof prepareRolldownBindingArtifact>>>()
      const compiledParserBindings=new Set<string>()
      if(experimentalRolldownParser){
        const entries=files!.listSync().filter(path=>path.endsWith('/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs'))
        if(entries.length>16)throw Error('Native parser binding selection exceeds owner limit')
        for(const entry of entries){
          const binding=await prepareRolldownBindingArtifact(files!,entry)
          parserBindings.set(binding.entry,binding)
        }
      }
      initializeCJSParser()
      const chargeModuleSource=createModuleSourceBudget()
      const source=(path:string)=>{
        const bytes=files!.readFileSync(path)
        chargeModuleSource(path,bytes.length)
        return new TextDecoder().decode(bytes).replace(/^\uFEFF/,'').replace(/^#![^\n]*/,'')
      }
      expose('__moduleResolve',(specifier,importer,mode)=>{
        const name=context.getString(specifier)
        const record=name.startsWith('data:')?{id:new URL(name).href,path:name,kind:'module'}:resolver.resolve(name,context.getString(importer),context.getString(mode)==='require'?'require':'import')
        return context.newString(JSON.stringify(record))
      })
      expose('__moduleDescribe',id=>context.newString(JSON.stringify(resolver.describe(context.getString(id)))))
      expose('__moduleRead',id=>context.newString(source(context.getString(id))))
      expose('__moduleLoad',handle=>{
        const id=context.getString(handle)
        const record=id.startsWith('data:')?{kind:'module',path:id}:resolver.describe(id)
        const contents=record.kind==='builtin'?undefined:id.startsWith('data:')?dataModuleSource(id):source(record.path)
        const result=context.newObject()
        try{
          const format=context.newString(record.kind)
          try{context.setProp(result,'format',format)}finally{format.dispose()}
          if(contents!==undefined){const text=context.newString(contents);try{context.setProp(result,'source',text)}finally{text.dispose()}}
          return result
        }catch(error){result.dispose();throw error}
      })
      expose('__moduleCompile',(id,transformed)=>{
        const measured=options.profileJobs||options.diagnostics
        const started=measured?performance.now():0
        let compilePath=''
        if(measured)cjsCompileCalls++
        try{
        const record=resolver.describe(context.getString(id))
        compilePath=record.path
        if(record.kind!=='commonjs'&&record.kind!=='builtin')throw Error('Expected a CommonJS module')
        const contents=record.kind==='builtin'?artifact.modules[record.id].cjs:context.typeof(transformed)==='string'?context.getString(transformed):source(record.path)
        const binding=parserBindings.get(record.path)
        if(binding){
          compiledParserBindings.delete(record.path)
          if(contents!==binding.source||source(record.path)!==binding.source)throw Error('Native parser requires the captured, unchanged Rolldown binding source')
        }
        // The exact pinned binding is validated above, but its WASI loader must
        // not run in the guest. The owner-side native service supplies its
        // supported surface in __moduleAdaptExports below.
        const wrapper='(function(exports,require,module,__filename,__dirname){\n'+(binding?'':contents)+'\n})'
        try{const result=record.kind==='builtin'&&record.id==='node:process'
          ?compileTrustedProcessBuiltin(engine,context,wrapper)
          :context.evalCode(wrapper,record.path)
          if(binding&&!result.error)compiledParserBindings.add(record.path)
          return result
        }
        catch(error){
          if(options.diagnostics)console.error('CommonJS host compilation failed',record.path,error instanceof Error?error.stack:String(error))
          throw error
        }
        }finally{if(measured){
          const ms=performance.now()-started;cjsCompileMs+=ms
          if(options.diagnostics){slowCJSCompiles.push({path:compilePath,ms});slowCJSCompiles.sort((a,b)=>b.ms-a.ms);if(slowCJSCompiles.length>16)slowCJSCompiles.pop()}
        }}
      })
      let callableFactory:ReturnType<typeof context.newObject>|undefined
      let bindingFactory:ReturnType<typeof context.newObject>|undefined
      let syncCompilerHost:ReturnType<typeof context.newObject>|undefined
      let parserFactory:ReturnType<typeof context.newObject>|undefined
      let validateParserOrigin:((operation:Parameters<typeof context.typeof>[0],callback:Parameters<typeof context.typeof>[0])=>void)|undefined
      let callableHost:ReturnType<typeof context.newObject>|undefined
      let bundlerBinding:ReturnType<typeof context.newObject>|undefined
      let bundlerHost:ReturnType<typeof context.newObject>|undefined
      if(experimentalRolldownParser){
        // Open before guest evaluation so synchronous Rolldown APIs can use a
        // dedicated compiler worker without loading the WASI binding in QuickJS.
        const parser=await getSynchronousCompiler()
        syncCompilerHost=context.newObject()
        const syncMethod=(name:string,fn:Parameters<typeof context.newFunction>[1])=>{const handle=context.newFunction(name,function(...args){try{return fn.apply(this,args)}catch(error){return {error:errorHandle(error)}}});try{context.setProp(syncCompilerHost!,name,handle)}finally{handle.dispose()}}
        syncMethod('createTsconfigCache',path=>context.newNumber(parser.createTsconfigCache(context.typeof(path)==='undefined'?undefined:context.getString(path))))
        syncMethod('clearTsconfigCache',handle=>{parser.clearTsconfigCache(context.getNumber(handle));return context.undefined})
        syncMethod('tsconfigCacheSize',handle=>context.newNumber(parser.tsconfigCacheSize(context.getNumber(handle))))
        syncMethod('transformSync',(filename,source,options,cache)=>{
          const result=parser.transformSync(context.getString(filename),context.getString(source),context.dump(options),context.typeof(cache)==='undefined'?undefined:context.getNumber(cache))
          return context.newString(JSON.stringify(result))
        })
        syncMethod('parseSync',(filename,source,options)=>context.newString(JSON.stringify(parser.parseSync(context.getString(filename),context.getString(source),context.typeof(options)==='undefined'?undefined:context.dump(options) as NativeParserOptions))))
        const bundler=createKernelBundlerHost({files:files!,signal:record.controller.signal,maxBytes:experimentalRolldownParser.maxSourceBytes,getParser:getNativeParser,enqueue(work){const pending=nativeCallableQueue.then(work);nativeCallableQueue=pending.catch(()=>{});return pending}})
        referencedBundlerWork=()=>bundler.pending>0
        nativeBundlerSnapshots.set(id,()=>bundler.snapshot())
        bundlerHost=context.newObject()
        const bundlerMethod=(name:string,fn:Parameters<typeof context.newFunction>[1])=>{const handle=context.newFunction(name,function(...args){try{return fn.apply(this,args)}catch(error){return {error:errorHandle(error)}}});try{context.setProp(bundlerHost!,name,handle)}finally{handle.dispose()}}
        bundlerMethod('create',()=>context.newNumber(bundler.create()))
        const bundlerJSON=(value:Parameters<typeof context.getString>[0])=>{
          if(context.typeof(value)==='undefined')return undefined
          const text=context.getString(value)
          if(new TextEncoder().encode(text).byteLength>experimentalRolldownParser!.maxSourceBytes)throw Error('Native bundler transport byte limit')
          return JSON.parse(text)
        }
        bundlerMethod('start',(handle,method,input,trace)=>context.newNumber(bundler.start(context.getNumber(handle),context.getString(method),bundlerJSON(input),context.getString(trace))))
        bundlerMethod('next',operation=>{const id=context.getNumber(operation);return networkPromise(()=>bundler.next(id))})
        bundlerMethod('reply',(operation,callback,reply)=>{bundler.reply(context.getNumber(operation),context.getNumber(callback),bundlerJSON(reply));return context.undefined})
        bundlerMethod('finish',operation=>{bundler.finish(context.getNumber(operation));return context.undefined})
        bundlerMethod('cancel',operation=>{bundler.cancel(context.getNumber(operation));return context.undefined})
        bundlerMethod('context',(scope,handle,method,args)=>{
          const scopeId=context.getNumber(scope),handleId=context.getNumber(handle),name=context.getString(method),values=bundlerJSON(args)
          return networkPromise(()=>bundler.context(scopeId,handleId,name,values))
        })
        bundlerMethod('reportError',message=>{emitOutput('error','Native bundler callback: '+context.getString(message)+'\n');return context.undefined})
        closeBundlerProcess=async()=>{try{await bundler.close()}finally{nativeBundlerSnapshots.delete(id);retiredBundlerSnapshots.push({pid:id,state:bundler.snapshot()});if(retiredBundlerSnapshots.length>8)retiredBundlerSnapshots.shift();bundlerBinding?.dispose();bundlerHost?.dispose()}}
        type CallableRecord={descriptor:unknown;hooks:Array<{name:string;order:unknown}>;remote?:number;queue?:Promise<void>}
        type CallableOperation={queue:unknown[];waiter?:{resolve(value:unknown):void;reject(error:Error):void};callback?:{id:number;resolve(value:unknown):void;reject(error:Error):void};cancelled:boolean}
        const registrations=new Map<number,CallableRecord>(),operations=new Map<number,CallableOperation>()
        const reservations=new Map<number,{handle:number;name:string;argsText:string;bytes:number;registration:CallableRecord}>()
        let reservationSequence=0
        let operationSequence=0,callbackSequence=0,callableClosed=false
        const callableWork=new Set<Promise<void>>()
        const event=(operation:CallableOperation,value:unknown)=>{if(operation.cancelled)return;if(operation.waiter){const waiter=operation.waiter;operation.waiter=undefined;waiter.resolve(value)}else operation.queue.push(value)}
        const cancel=(operation:CallableOperation)=>{operation.cancelled=true;operation.callback?.reject(Error('Native callable process cancelled'));operation.callback=undefined;operation.waiter?.reject(Error('Native callable process cancelled'));operation.waiter=undefined;operation.queue=[]}
        callableHost=context.newObject()
        const method=(name:string,fn:Parameters<typeof context.newFunction>[1])=>{const handle=context.newFunction(name,function(...args){try{return fn.apply(this,args)}catch(error){return {error:errorHandle(error)}}});try{context.setProp(callableHost!,name,handle)}finally{handle.dispose()}}
        method('register',(handleValue,descriptorValue,hooksValue)=>{
          const handle=context.getNumber(handleValue)
          if(callableClosed||registrations.size>=callableLimits.maxHandles||registrations.has(handle))throw Error('Native callable registration limit')
          const descriptorText=context.getString(descriptorValue),hooksText=context.getString(hooksValue)
          if(descriptorText.length>callableLimits.maxCallbackBytes||hooksText.length>4096)throw Error('Native callable descriptor limit')
          registrations.set(handle,{descriptor:JSON.parse(descriptorText),hooks:JSON.parse(hooksText)})
          return context.undefined
        })
        method('release',handleValue=>{registrations.delete(context.getNumber(handleValue));return context.undefined})
        const validateCallableOrigin=(originOperationValue:Parameters<typeof context.typeof>[0],originCallbackValue:Parameters<typeof context.typeof>[0])=>{
          const originOperation=context.typeof(originOperationValue)==='undefined'?undefined:context.getNumber(originOperationValue)
          const originCallback=context.typeof(originCallbackValue)==='undefined'?undefined:context.getNumber(originCallbackValue)
          if(originOperation!==undefined||originCallback!==undefined){
            if(typeof originOperation!=='number'||!Number.isSafeInteger(originOperation)||originOperation<=0||typeof originCallback!=='number'||!Number.isSafeInteger(originCallback)||originCallback<=0)throw Error('Invalid native callable callback origin')
            // Reject only work caused by a callback that still blocks native execution.
            // Unrelated requests may overlap, and async warning handlers may resume
            // after their ignored return value has already been acknowledged.
            if(operations.get(originOperation)?.callback?.id===originCallback)throw Error('Nested native callable invocation from a pending callback is unsupported')
          }
        }
        validateParserOrigin=validateCallableOrigin
        method('reserve',(handleValue,methodValue,argsValue,originOperationValue,originCallbackValue)=>{
          if(callableClosed||record.controller.signal.aborted)throw Error('Native callable process cancelled')
          validateCallableOrigin(originOperationValue,originCallbackValue)
          if(reservations.size>=1024+callableLimits.maxPending)throw Error('Native callable admission queue limit')
          const handle=context.getNumber(handleValue),registration=registrations.get(handle),name=context.getString(methodValue),argsText=context.getString(argsValue)
          if(!registration||!['resolveId','load','transform','watchChange'].includes(name)||argsText.length>experimentalRolldownParser!.maxSourceBytes)throw Error('Unsupported native callable invocation')
          if(!Array.isArray(JSON.parse(argsText)))throw Error('Invalid native callable arguments')
          // Waiting and active requests share the existing input budget. Charge
          // a minimum per entry so tiny payloads cannot create free queue slots.
          const bytes=Math.max(256,new TextEncoder().encode(argsText).byteLength)
          if(bytes>experimentalRolldownParser!.maxSourceBytes-nativeCallablePendingBytes)throw Error('Native callable aggregate pending input limit')
          nativeCallablePendingBytes+=bytes
          const reservation=++reservationSequence
          reservations.set(reservation,{handle,name,argsText,bytes,registration})
          return context.newNumber(reservation)
        })
        const releaseReservation=(key:number)=>{const reservation=reservations.get(key);if(reservation){reservations.delete(key);nativeCallablePendingBytes-=reservation.bytes}}
        method('releaseReservation',idValue=>{releaseReservation(context.getNumber(idValue));return context.undefined})
        method('start',(handleValue,methodValue,_argsValue,scopeValue,originOperationValue,originCallbackValue,reservationValue)=>{
          if(callableClosed||record.controller.signal.aborted)throw Error('Native callable process cancelled')
          validateCallableOrigin(originOperationValue,originCallbackValue)
          if(operations.size>=callableLimits.maxPending)throw Error('Native callable operation limit')
          const key=context.getNumber(reservationValue),reservation=reservations.get(key)
          if(!reservation||reservation.handle!==context.getNumber(handleValue)||reservation.name!==context.getString(methodValue))throw Error('Invalid native callable admission reservation')
          const {registration,name,argsText,bytes}=reservation,args=JSON.parse(argsText)
          const scope=context.typeof(scopeValue)==='undefined'?undefined:context.getNumber(scopeValue)
          if(scope!==undefined&&(!bundler.hasScope(scope)||name!=='resolveId'))throw Error('Unsupported native callable callback scope')
          reservations.delete(key)
          pendingNativeCompilerCalls++
          const operation:CallableOperation={queue:[],cancelled:false},operationId=++operationSequence
          operations.set(operationId,operation)
          const work=async()=>{
            if(operation.cancelled||callableClosed)throw Error('Native callable process cancelled')
            const parser=await getNativeParser()
            if(registration.remote===undefined){
              const remote=await parser.createCallable(registration.descriptor,scope)
              if(JSON.stringify(remote.hooks)!==JSON.stringify(registration.hooks)){await parser.disposeCallable(remote.handle);throw Error('Native callable synchronous hook metadata mismatch')}
              registration.remote=remote.handle;nativeCallableHandles++
            }
            if(operation.cancelled||callableClosed)throw Error('Native callable process cancelled')
            const remote=registration.remote
            nativeCallableRoutes.set(remote,(method,args)=>new Promise((resolve,reject)=>{
              if(operation.cancelled||callableClosed){reject(Error('Native callable process cancelled'));return}
              const callbackId=++callbackSequence
              operation.callback={id:callbackId,resolve,reject}
              event(operation,{type:'callback',id:callbackId,method,args})
            }))
            try{
              let result:unknown
              if(name==='resolveId')result=await parser.resolveCallable(remote,args[0],args[1],args[2],scope)
              else if(name==='watchChange'){
                const change=args[1]?.event
                if(typeof args[0]!=='string'||!['create','update','delete'].includes(change))throw Error('Unsupported native callable file event')
                result=await parser.updateCallable(remote,args[0],change==='delete'?undefined:files!.readFileSync(args[0]),change)
              }else result=await parser.invokeCallable(remote,name as 'load'|'transform',args)
              event(operation,{type:'result',value:result})
              nativeCallableCompleted++
            }finally{nativeCallableRoutes.delete(remote)}
          }
          // A native callable callback identifies its handle, not an invocation.
          // Keep one route active per handle, including scoped bundler callbacks.
          const serialized=()=>{const result=(registration.queue??Promise.resolve()).then(work);registration.queue=result.catch(()=>{});return result}
          const pending=(scope===undefined?nativeCallableQueue.then(serialized):serialized()).catch(error=>{nativeCallableFailed++;event(operation,{type:'error',message:String(error)})}).finally(()=>{nativeCallablePendingBytes-=bytes;pendingNativeCompilerCalls--;callableWork.delete(pending)})
          callableWork.add(pending)
          if(scope===undefined)nativeCallableQueue=pending
          return context.newNumber(operationId)
        })
        method('next',idValue=>{
          const operation=operations.get(context.getNumber(idValue));if(!operation||operation.cancelled)throw Error('Native callable operation is closed')
          return networkPromise(()=>{
            if(operation.queue.length)return Promise.resolve(operation.queue.shift())
            if(operation.waiter)throw Error('Native callable operation already waiting')
            return new Promise((resolve,reject)=>{operation.waiter={resolve,reject}})
          })
        })
        method('reply',(idValue,callbackValue,replyValue)=>{
          const operation=operations.get(context.getNumber(idValue)),callback=operation?.callback
          if(!callback||callback.id!==context.getNumber(callbackValue))throw Error('Unknown native callable callback reply')
          const text=context.getString(replyValue);if(text.length>callableLimits.maxCallbackBytes)throw Error('Native callable callback reply limit')
          const reply=JSON.parse(text);operation!.callback=undefined
          if(reply.type==='error')callback.reject(Error(String(reply.message)))
          else if(reply.type==='string'&&typeof reply.value==='string')callback.resolve(reply.value)
          else if(reply.type==='null')callback.resolve(null)
          else if(reply.type==='undefined')callback.resolve(undefined)
          else callback.reject(Error('Invalid native callable primitive reply'))
          return context.undefined
        })
        method('finish',idValue=>{const key=context.getNumber(idValue),operation=operations.get(key);if(operation){cancel(operation);operations.delete(key)}return context.undefined})
        method('cancel',idValue=>{const operation=operations.get(context.getNumber(idValue));if(operation)cancel(operation);return context.undefined})
        method('reportError',message=>{emitOutput('error','Native callable ignored-return handler: '+context.getString(message)+'\n');return context.undefined})
        const factorySource=`(host,bundlerHost,syncHost)=>{const scope=new globalThis.__webContainerHost.AsyncLocalStorage();const callbackScope=new globalThis.__webContainerHost.AsyncLocalStorage();const dispatch=(${createGuestCallableDispatch.toString()})({isScoped:()=>scope.getStore()!==undefined,reserve:(h,m,a,origin)=>host.reserve(h,m,JSON.stringify(a),origin?.operation,origin?.callback),releaseReservation:host.releaseReservation,start:(h,m,a,origin,reservation)=>host.start(h,m,undefined,scope.getStore(),origin?.operation,origin?.callback,reservation),next:id=>host.next(id).then(JSON.parse),reply:(id,c,r)=>host.reply(id,c,JSON.stringify(r)),finish:host.finish,cancel:host.cancel,reportError:host.reportError},callbackScope);const sync={createTsconfigCache:path=>syncHost.createTsconfigCache(path),clearTsconfigCache:handle=>syncHost.clearTsconfigCache(handle),tsconfigCacheSize:handle=>syncHost.tsconfigCacheSize(handle),transformSync:(filename,source,options,cache)=>JSON.parse(syncHost.transformSync(filename,source,options,cache)),parseSync:(filename,source,options)=>JSON.parse(syncHost.parseSync(filename,source,options))};return {binding:target=>(${createRolldownGuestBinding.toString()})(target,sync),parser:parseHost=>(${createGuestParserAdapter.toString()})(parseHost,callbackScope),callable:Original=>(${createGuestCallableAdapter.toString()})(Original,dispatch,{register:(h,d,k)=>host.register(h,JSON.stringify(d),JSON.stringify(k)),release:host.release}),bundler:(${createGuestBundlerAdapter.toString()})({create:bundlerHost.create,start:(h,m,o)=>bundlerHost.start(h,m,JSON.stringify(o),String(new Error().stack??'').slice(0,2000)),next:id=>bundlerHost.next(id).then(JSON.parse),reply:(id,c,r)=>bundlerHost.reply(id,c,JSON.stringify(r)),finish:bundlerHost.finish,cancel:bundlerHost.cancel,context:(s,h,m,a)=>bundlerHost.context(s,h,m,JSON.stringify(a)).then(JSON.parse),reportError:bundlerHost.reportError},scope,${restoreGuestBindingResult.toString()},{maxBytes:${experimentalRolldownParser.maxSourceBytes},maxCallbacks:1024})}}`
        const make=context.unwrapResult(context.evalCode(factorySource,'native-callable-guest-adapter.js'))
        try{
          const result=context.unwrapResult(context.callFunction(make,context.undefined,callableHost,bundlerHost,syncCompilerHost))
          try{bindingFactory=context.getProp(result,'binding');callableFactory=context.getProp(result,'callable');parserFactory=context.getProp(result,'parser');bundlerBinding=context.getProp(result,'bundler')}finally{result.dispose()}
        }finally{make.dispose()}
        closeCallableProcess=async()=>{
          callableClosed=true;for(const operation of operations.values())cancel(operation);operations.clear()
          for(const key of reservations.keys())releaseReservation(key)
          let cleanupError:unknown
          try{
            await Promise.all(callableWork)
            const parser=nativeParserInstance
            for(const registration of registrations.values())if(registration.remote!==undefined){nativeCallableRoutes.delete(registration.remote);try{if(parser&&!parser.closed)await parser.disposeCallable(registration.remote)}catch(error){cleanupError??=error}finally{nativeCallableHandles--}}
          }finally{registrations.clear();bindingFactory?.dispose();callableFactory?.dispose();parserFactory?.dispose();syncCompilerHost?.dispose();callableHost?.dispose()}
          if(cleanupError)throw cleanupError
        }
      }
      if(experimentalRolldownParser)expose('__moduleAdaptExports',(path,exports)=>{
        if(!compiledParserBindings.has(context.getString(path)))return
        const synthetic=context.unwrapResult(context.callFunction(bindingFactory!,context.undefined,exports))
        synthetic.dispose()
        const nativeParse=context.newFunction('parse',(filenameValue,sourceValue,optionsValue,originOperationValue,originCallbackValue)=>{
          try{
            if(record.controller.signal.aborted||budget.expired)throw Error('Native parser operation cancelled')
            validateParserOrigin!(originOperationValue,originCallbackValue)
            if(context.typeof(filenameValue)!=='string'||context.typeof(sourceValue)!=='string')throw TypeError('Native parser requires filename and source strings')
            const filename=context.getString(filenameValue),text=context.getString(sourceValue)
            const settings=context.typeof(optionsValue)==='undefined'?undefined:context.dump(optionsValue) as NativeParserOptions
            const bytes=new TextEncoder().encode(text).byteLength
            // maxSourceBytes covers one source and all queued sources together,
            // independently from the existing network operation byte ceiling.
            if(bytes>experimentalRolldownParser!.maxSourceBytes-nativeParserPendingSourceBytes)throw Object.assign(Error('Native parser pending source bytes exceed owner policy'),{code:'ERR_RESOURCE_LIMIT'})
            nativeParserCalls++;nativeParserPendingSourceBytes+=bytes;pendingNativeCompilerCalls++
            try{return networkPromise(async()=>{
              try{
                if(record.controller.signal.aborted)throw Error('Native parser operation cancelled')
                const parser=await getNativeParser()
                if(record.controller.signal.aborted)throw Error('Native parser operation cancelled')
                const result=await parser.parse(filename,text,settings,'callback-origin-validated')
                if(record.controller.signal.aborted)throw Error('Native parser operation cancelled')
                nativeParserCompletedCalls++
                return result
              }catch(error){
                nativeParserFailedCalls++
                if(nativeParserInstance?.closed&&!shuttingDown)nativeParserState='failed'
                throw error
              }finally{nativeParserCalls--;nativeParserPendingSourceBytes-=bytes;pendingNativeCompilerCalls--}
            })}catch(error){nativeParserFailedCalls++;nativeParserCalls--;nativeParserPendingSourceBytes-=bytes;pendingNativeCompilerCalls--;throw error}
          }catch(error){return {error:errorHandle(error)}}
        })
        // The guest still receives a guest Promise and a guest-owned object. The
        // installed Rolldown wrapper keeps its lazy AST decoding and fixups.
        const factory=parserFactory!.dup()
        try{
          const parse=context.unwrapResult(context.callFunction(factory,context.undefined,nativeParse))
          try{context.setProp(exports,'parse',parse)}finally{parse.dispose()}
        }finally{factory.dispose();nativeParse.dispose()}
        const original=context.getProp(exports,'BindingCallableBuiltinPlugin')
        try{
          const adapted=context.unwrapResult(context.callFunction(callableFactory!,context.undefined,original))
          try{context.setProp(exports,'BindingCallableBuiltinPlugin',adapted)}finally{adapted.dispose()}
        }finally{original.dispose()}
        context.setProp(exports,'BindingBundler',bundlerBinding!)
        for(const name of ['startAsyncRuntime','shutdownAsyncRuntime']){
          const method=context.getProp(bundlerBinding!,name)
          try{context.setProp(exports,name,method)}finally{method.dispose()}
        }
        for(const name of ['BindingDevEngine','BindingWatcherBundler']){
          const factory=context.getProp(bundlerBinding!,'unsupportedRuntimeConstructor'),label=context.newString(name)
          try{const guard=context.unwrapResult(context.callFunction(factory,context.undefined,label));try{context.setProp(exports,name,guard)}finally{guard.dispose()}}finally{factory.dispose();label.dispose()}
        }
      })
      const hostCompilePaths=context.newArray()
      try{
        let index=0
        for(const path of parserBindings.keys()){
          const value=context.newString(path)
          try{context.setProp(hostCompilePaths,index++,value)}finally{value.dispose()}
        }
        context.setProp(context.global,'__moduleHostCompilePaths',hostCompilePaths)
      }finally{hostCompilePaths.dispose()}
      context.unwrapResult(context.evalCode(moduleHooks+'\n'+moduleBootstrap,'module-loader.js')).dispose()
      moduleResolveHook=context.unwrapResult(context.evalCode('globalThis.__webContainerHost.modules.resolve','module-resolve-hook.js'))
      // loadSource validates format, hooks and source size before returning.
      // The engine needs only text here, not a JSON-encoded copy of the record.
      moduleLoadHook=context.unwrapResult(context.evalCode('(id)=>globalThis.__webContainerHost.modules.loadSource(id).source','module-load-hook.js'))
      context.unwrapResult(context.evalCode(`
        globalThis.process=globalThis.__webContainerHost.modules.load('node:process');
        globalThis.Buffer=globalThis.__webContainerHost.modules.load('node:buffer').Buffer;
        globalThis.atob=globalThis.__webContainerHost.modules.load('node:buffer').atob;
        globalThis.btoa=globalThis.__webContainerHost.modules.load('node:buffer').btoa;
        globalThis.crypto=globalThis.__webContainerHost.modules.load('node:crypto').webcrypto;
        globalThis.performance=globalThis.__webContainerHost.modules.load('node:perf_hooks').performance;
        globalThis.__webContainerHost.preparedBuiltins=Object.create(null);
      `)).dispose()
      if(typeof artifact.inspection!=='string')throw Error('Missing trusted inspection initializer, rebuild kernel builtins')
      markBootstrap('node-globals-ready')
      const inspectionContext=context as typeof context & {initializeInspection(initializer:Parameters<typeof context.callFunction>[0]):ReturnType<typeof context.callFunction>}
      if(typeof inspectionContext.initializeInspection!=='function')throw Error('Engine wrapper lacks private inspection initialization')
      const inspectionCompileStarted=performance.now()
      const initializer=context.unwrapResult(compileTrustedInspectionInitializer(engine,context,`(function(binding){
        const module={exports:{}};const exports=module.exports;
        ${artifact.inspection}
        const load=globalThis.__webContainerHost.modules.load;
        const names=new Set(${JSON.stringify(Object.keys(artifact.modules))});
        const formatter=module.exports(binding,{process:globalThis.process,load,isBuiltin:name=>names.has(name.startsWith('node:')?name:'node:'+name)});
        const util=globalThis.__webContainerHost.nodeCore.util;
        Object.assign(util,{inspect:formatter.inspect,format:formatter.format,formatWithOptions:formatter.formatWithOptions,stripVTControlCharacters:formatter.stripVTControlCharacters});
        // The legacy polyfill has non-configurable throwing placeholders.
        // Publish the supported native predicates as a fresh Node-style object.
        util.types={...binding.types};
      })`))
      const inspectionCompileMs=performance.now()-inspectionCompileStarted
      const inspectionInitializeStarted=performance.now()
      try{context.unwrapResult(inspectionContext.initializeInspection(initializer)).dispose()}finally{initializer.dispose()}
      if(diagnostics)self.postMessage({type:'job-profile',value:{pid:id,phase:'inspection-initializer',at:inspectionCompileStarted,ms:performance.now()-inspectionCompileStarted,jobs:0,compileOrReadMs:inspectionCompileMs,initializeMs:performance.now()-inspectionInitializeStarted}})
      markBootstrap('inspection-ready')
      const cryptoContext=context as typeof context & {initializeCrypto(initializer:Parameters<typeof context.callFunction>[0]):ReturnType<typeof context.callFunction>}
      if(typeof cryptoContext.initializeCrypto!=='function')throw Error('Engine wrapper lacks private crypto initialization')
      const cryptoInitializer=context.unwrapResult(context.evalCode('(function(binding){globalThis.__webContainerHost.timingSafeEqual=binding})','crypto-initializer.js'))
      try{context.unwrapResult(cryptoContext.initializeCrypto(cryptoInitializer)).dispose()}finally{cryptoInitializer.dispose()}
      const terminationContext=context as typeof context & {initializeTermination?:(initializer:Parameters<typeof context.callFunction>[0])=>ReturnType<typeof context.callFunction>}
      if(terminationContext.initializeTermination){
        const requestExit=context.newFunction('requestExit',code=>{
          const value=context.getNumber(code)
          if(!Number.isInteger(value))throw Error('Invalid process exit status')
          requestedExit=value&255
        })
        context.setProp(context.global,'__requestProcessExit',requestExit)
        requestExit.dispose()
        const initializer=context.unwrapResult(context.evalCode('(function(binding){const request=globalThis.__requestProcessExit;delete globalThis.__requestProcessExit;globalThis.__webContainerHost.exit=code=>{request(code);binding()}})','termination-initializer.js'))
        try{context.unwrapResult(terminationContext.initializeTermination(initializer)).dispose()}finally{initializer.dispose()}
      }
      const cjsNames=(path:string,seen=new Set<string>()):Set<string>=>{
        if(seen.has(path))return new Set()
        seen.add(path)
        const parsed=parseCJS(source(path),path),names=new Set(parsed.exports)
        for(const reexport of parsed.reexports){
          try{
            const target=resolver.resolve(reexport,path,'require')
            if(target.kind==='commonjs')for(const name of cjsNames(target.path,seen))names.add(name)
          }catch{/* Optional reexports are resolved by require at execution time. */}
        }
        return names
      }
      runtime.setModuleLoader(id=>{
        const loadStart=diagnostics?performance.now():0;let sourceChars=0
        try{
        const hookedSource=()=>{
          const arg=context.newString(id)
          // Module callbacks re-enter QuickJS through a synchronous C call.
          // Keep yielding at the outer async entry, never across this frame.
          const invoke=()=>context.callFunction(moduleLoadHook!,context.undefined,arg)
          try{const result=context.unwrapResult(candidate?candidate.synchronous(invoke):invoke());try{const loaded=context.getString(result);if(diagnostics)sourceChars=loaded.length;return loaded}finally{result.dispose()}}finally{arg.dispose()}
        }
        if(id.startsWith('data:'))return `import.meta.url=${JSON.stringify(id)};import.meta.resolve=specifier=>JSON.parse(globalThis.__webContainerHost.modules.resolve(String(specifier),import.meta.url,'import')).id;\n`+hookedSource()
        const record=resolver.describe(id)
        if(record.kind==='builtin'){
          const names=artifact.modules[id].exports.filter(name=>name!=='default')
          return `const value=globalThis.__webContainerHost.modules.load(${JSON.stringify(id)});export default value;\n`+
            names.map(name=>`export const ${name}=value[${JSON.stringify(name)}];`).join('\n')
        }
        if(record.kind==='module')return `import.meta.url=${JSON.stringify(id)};import.meta.filename=${JSON.stringify(record.path)};import.meta.dirname=${JSON.stringify(record.path.slice(0,record.path.lastIndexOf('/'))||'/')};import.meta.resolve=specifier=>JSON.parse(globalThis.__webContainerHost.modules.resolve(String(specifier),import.meta.url,'import')).id;\n`+hookedSource()
        const names=record.kind==='commonjs'?[...cjsNames(record.path)].filter(name=>name!=='default'&&name!=='module.exports'):[]
        return `const value=globalThis.__webContainerHost.modules.load(${JSON.stringify(record.path)});export default value;${record.kind==='commonjs'?'export {value as "module.exports"};':''}\n`+
          names.map((name,index)=>`const named${index}=value[${JSON.stringify(name)}];export {named${index} as ${JSON.stringify(name)}};`).join('\n')
      }catch(error){return {error:errorHandle(error)}}finally{
        if(diagnostics){const ms=performance.now()-loadStart;moduleLoadCalls++;moduleLoadMs+=ms;moduleSourceChars+=sourceChars
          largestModuleSources.push({path:id,chars:sourceChars,ms});largestModuleSources.sort((a,b)=>b.chars-a.chars);if(largestModuleSources.length>16)largestModuleSources.pop()
        }
      }},(base,requested)=>{
        try{
          if(base.startsWith('data:')&&!requested.startsWith('node:')&&!requested.startsWith('file:')&&!requested.startsWith('data:'))throw Object.assign(Error('Data modules cannot resolve relative or package imports'),{code:'ERR_UNSUPPORTED_RESOLVE_REQUEST'})
          const args=[context.newString(requested),context.newString(base),context.newString('import')]
          try{
            const invoke=()=>context.callFunction(moduleResolveHook!,context.undefined,...args)
            const result=context.unwrapResult(candidate?candidate.synchronous(invoke):invoke())
            try{return JSON.parse(context.getString(result)).id}finally{result.dispose()}
          }finally{for(const arg of args)arg.dispose()}
        }catch(error){return {error:errorHandle(error)}}
      })
      emitWorkerOnline()
      if(options.entry!==undefined){
      const entry=resolver.resolve(options.entry,'/entry.mjs','require')
      code=entry.kind==='commonjs'||entry.kind==='json'
        ?`globalThis[Symbol.for('web-container:task-queue')].task(()=>globalThis.__webContainerHost.modules.run(${JSON.stringify(entry.id)}));`
        :`import ${JSON.stringify(options.entry)};`
      }
      if(options.evalCommonJS)code=`{const module={exports:{}};globalThis[Symbol.for('web-container:task-queue')].task(function(require,module,exports,__filename,__dirname){${code}\n},undefined,[globalThis.__webContainerHost.modules.createRequire(${JSON.stringify(processPath(record.cwd,'__eval__.cjs'))}),module,module.exports,'[eval]','.']);}`
      const entrySource=options.entry!==undefined?source(resolver.resolve(options.entry,'/entry.mjs','require').path):String(code)
      const requested=(artifact.preparations??[]).filter(preparation=>entrySource.includes(`node:${preparation.name}`))
      for(const preparation of requested)if(preparation.requiresGuestWasm&&!options.guestWasm)throw Object.assign(Error(`node:${preparation.name} requires guestWasm`),{code:'ERR_UNSUPPORTED_OPERATION'})
      if(requested.length){
        // A static entry import executes before this module's preparation body.
        // Load the entry only after its required asynchronous builtins are ready.
        if(options.entry!==undefined&&resolver.resolve(options.entry,'/entry.mjs','require').kind==='module')code=`await import(${JSON.stringify(options.entry)});`
        code=`for(const prepare of [${requested.map(preparation=>preparation.source).join(',')}])await prepare();\n${code}`
      }
    }
    if(diagnostics?.startup)diagnostics.startup.bootstrapMs=performance.now()-contextReady
    if(diagnostics)self.postMessage({type:'job-profile',value:{pid:id,phase:'process-startup-timeline',at:started,ms:performance.now()-started,jobs:0,owner:record.owner,engineReady,runtimeReady:clockStart,contextReady,bootstrapReady:performance.now(),bootstrapMarks}})
    emitWorkerOnline()
    const evaluationStart=options.profileJobs?performance.now():0
    const evaluation=await engineAccess.run(()=>experimentalFibers?driveFiber((context as FiberContext).startFiberEval(code,processPath(record.cwd,'workspace.mjs'),1),'evaluation'):candidate?candidate.run(()=>(context as QuickJSAsyncContext).evalCodeAsync(code,processPath(record.cwd,'workspace.mjs'),{type:'module'})):context.evalCode(code,processPath(record.cwd,'workspace.mjs'),{type:'module'}))
    if(options.profileJobs)profile('evaluation',evaluationStart,0)
    if(evaluation.error){const error=dumpFailure(evaluation.error,'evaluate');preserveWorkerError(error);evaluation.dispose();throw Error(guestError(error))}
    try{
      let idleCheckpoint=false
      let phase:'poll'|'check'='poll',pollRemaining=-1,pollBoundary=0,checkQueue:number[]=[]
      for(;;){
        record.controller.signal.throwIfAborted()
        if(budget.expired)throw Error('Execution timed out')
        if(!runtime.hasPendingJob()&&phase==='poll'){
          // Snapshot this poll phase. New completions belong to the next turn,
          // otherwise continuous I/O can indefinitely postpone the check phase.
          // Observed worker ports may become ready during another callback.
          // Each gets one bounded drain, including arrivals during that drain.
          if(pollRemaining<0){
            if(activeCheckBatch){activeCheckBatch.endAt=performance.now();activeCheckBatch.endCompletions=engineAccess.pending;activeCheckBatch.nextImmediates=immediates.size;activeCheckBatch=undefined}
            pollBoundary=engineAccess.boundary;pollRemaining=engineAccess.pendingThrough(pollBoundary);workerPoll.begin()
          }
          if(engineAccess.pending>0&&(pollRemaining>0||workerPoll.pending)){
            budget.endTurn(false);budget.beginTurn()
            // Host callbacks are separate tasks. Drain their microtasks before
            // dispatching the next queued timer, socket or filesystem completion.
            // Finish the active MessagePort batch before dispatching another
            // port or unrelated completion, with microtasks between messages.
            workerPoll.activate(engineAccess.nextWorkerEndpoint)
            engineAccess.drain(1,workerPoll.active)
            pollRemaining=engineAccess.pendingThrough(pollBoundary)
          }
        }
        const pumpStart=diagnostics||options.profileJobs?performance.now():0
        const checkpoint=diagnostics?{at:pumpStart,phase,pollRemaining,checkCallbacks:checkQueue.length,completions:engineAccess.pending,guestJobsBefore:runtime.hasPendingJob()} as (typeof schedulerCheckpoints)[number]:undefined
        if(checkpoint){schedulerCheckpoints.push(checkpoint);if(schedulerCheckpoints.length>32)schedulerCheckpoints.shift();emitLiveScheduling?.()}
        const asyncContext=context as typeof context & {callFunctionAsync:(...args:Parameters<typeof context.callFunction>)=>Promise<ReturnType<typeof context.callFunction>>}
        const jobs=await engineAccess.run(async()=>{
          if(experimentalFibers){
            return driveFiber((context as FiberContext).startFiberCall(fiberJobs!),'jobs')
          }
          return candidate?candidate.run(()=>asyncContext.callFunctionAsync(executeJobs,context.undefined,jobLimit)):context.callFunction(executeJobs,context.undefined,jobLimit)
        })
        if(options.profileJobs)profile('job',pumpStart,jobs.error?-1:context.getNumber(jobs.value))
        if(checkpoint){checkpoint.pumpMs=performance.now()-pumpStart;checkpoint.guestJobsAfter=runtime.hasPendingJob()}
        if(diagnostics){diagnostics.jobBatches++;diagnostics.jobPumpMs+=performance.now()-pumpStart;if(!jobs.error)diagnostics.jobs+=context.getNumber(jobs.value)}
        if(jobs.error){const error=dumpFailure(jobs.error,'jobs');preserveWorkerError(error);jobs.dispose();throw Error(guestError(error))}
        if(context.getNumber(jobs.value)>0)idleCheckpoint=false
        jobs.dispose()
        if(callbackFailure)throw Error(callbackFailure)
        if(!runtime.hasPendingJob()){
          const ticks=await engineAccess.run(()=>experimentalFibers?driveFiber((context as FiberContext).startFiberCall(drainTicks),'nextTick'):candidate?candidate.run(()=>asyncContext.callFunctionAsync(drainTicks,context.undefined)):context.callFunction(drainTicks,context.undefined))
          if(ticks.error){const error=dumpFailure(ticks.error,'nextTick');preserveWorkerError(error);ticks.dispose();throw Error(guestError(error))}
          ticks.dispose()
        }
        if(callbackFailure)throw Error(callbackFailure)
        const state=context.getPromiseState(evaluation.value)
        if(state.type==='fulfilled'){
          if(!state.notAPromise)state.value.dispose()
        }
        if(state.type==='rejected'){const error=dumpFailure(state.error,'promise');preserveWorkerError(error);state.error.dispose();throw Error(guestError(error))}
        if(!runtime.hasPendingJob()&&!engineAccess.pending&&!referenced()){
          // A socket can lose its final reference before the host resolves its
          // close event. Drain host microtasks, then guest jobs, before deciding
          // whether the module is truly stranded or the process can exit.
          if(!idleCheckpoint){
            idleCheckpoint=true;budget.endTurn(false)
            await scheduler.checkpoint();budget.beginTurn();continue
          }
          if(state.type==='fulfilled')break
          failureExitCode=13
          throw Error('Unsettled top-level await: no referenced work can resolve it')
        }
        idleCheckpoint=false
        // Dispatch one queued immediate after microtasks. Draining its promise
        // jobs on the next turn preserves microtasks between callbacks, FIFO,
        // and cancellation by earlier callbacks. Host messages still get time.
        if(!runtime.hasPendingJob()&&phase==='poll'&&pollRemaining===0&&!workerPoll.pending){
          phase='check';checkQueue=[...immediates.keys()]
          if(diagnostics&&checkQueue.length){
            const queued=engineAccess.pendingSnapshot(pollBoundary)
            activeCheckBatch={sequence:++checkBatchCount,at:performance.now(),callbacks:checkQueue.length,dispatched:0,cancelled:0,completions:engineAccess.pending,queued,sources:engineAccess.pendingSources(),ports:workerPoll.diagnosticSnapshot(queued.workers.map(group=>group.endpoint))}
            checkBatches.push(activeCheckBatch);if(checkBatches.length>64)checkBatches.shift()
          }
        }
        if(!runtime.hasPendingJob()&&phase==='check'&&checkQueue.length){
          // This callback starts a new host task, not another microtask in the
          // previous task. Bounded processes retain their original deadline.
          budget.endTurn(false);budget.beginTurn()
          const key=checkQueue.shift()!,entry=immediates.get(key)
          if(activeCheckBatch){if(entry)activeCheckBatch.dispatched++;else activeCheckBatch.cancelled++}
          if(entry){immediates.delete(key);entry.deferred.resolve();entry.deferred.dispose()}
        }
        if(phase==='check'&&checkQueue.length===0){phase='poll';pollRemaining=-1}
        // Yield to editor/agent file commands and timers between bounded job batches.
        const yieldStart=diagnostics?performance.now():0
        if(checkpoint)checkpoint.beforeYieldMs=yieldStart-pumpStart-(checkpoint.pumpMs??0)
        const ready=runtime.hasPendingJob()||engineAccess.pending>0||immediates.size>0||checkQueue.length>0||workerPoll.pending
        budget.endTurn(ready)
        await scheduler.wait(ready,budget.waitTimeout)
        if(checkpoint)checkpoint.yieldMs=performance.now()-yieldStart
        budget.beginTurn()
        if(diagnostics){diagnostics.yieldCount++;diagnostics.yieldWaitMs+=performance.now()-yieldStart}
      }
    }finally{evaluation.dispose()}
    const processValue=context.getProp(context.global,'process')
    try{if(context.typeof(processValue)==='object'){
      const exitValue=context.getProp(processValue,'exitCode')
      try{const value=context.dump(exitValue);if(value!==undefined){if(!Number.isInteger(value)||value<0||value>255)throw Error('Invalid process exitCode');if(value!==0)failureCause={exitCode:value}}}finally{exitValue.dispose()}
    }}finally{processValue.dispose()}
  }catch(error){
    if(requestedExit===undefined){failure=String(error);failureCause=error}
    if(options.profileJobs)self.postMessage({type:'job-profile',value:{pid:id,phase:'failure',at:performance.now(),ms:performance.now()-started,jobs:-1,error:failure,budget:budget.snapshot(),pendingCompletions:engineAccess.pending,timers:timers.size,immediates:immediates.size,scheduling:candidate?.schedulingMetrics()}})
  }finally{
    const scheduling=candidate?.schedulingMetrics()
    for(const [op,total] of wasmTotals)self.postMessage({type:'job-profile',value:{pid:id,phase:op===0?'wasm-compile-total':op===2?'wasm-instantiate-total':'wasm-call-inclusive-total',at:performance.now(),ms:total.ms,jobs:total.calls,...(op===0&&wasmModuleTiming?{moduleStages:wasmModuleTiming.snapshot()}:{})}})
    if(diagnostics){
      // Child runtimes can still be alive when the root result is delivered.
      // Snapshot their bounded traces now, before the caller closes the kernel.
      const traces=record.owner===0?activeHostTaskTraces.values():[hostTaskTrace]
      for(const trace of traces)self.postMessage({type:'host-task-scheduling',value:trace})
      self.postMessage({type:'job-profile',value:{pid:id,phase:'commonjs-compilation-total',at:performance.now(),ms:cjsCompileMs,jobs:cjsCompileCalls,slowCJSCompiles}})
      self.postMessage({type:'job-profile',value:{pid:id,phase:'module-source-loading-total',at:performance.now(),ms:moduleLoadMs,jobs:moduleLoadCalls,moduleSourceChars,largestModuleSources}})
      if(schedulerCheckpoints.length)self.postMessage({type:'job-profile',value:{pid:id,phase:'scheduler-checkpoints',at:performance.now(),ms:Math.max(0,...schedulerCheckpoints.map(row=>row.pumpMs??0)),jobs:schedulerCheckpoints.length,schedulerCheckpoints}})
      if(checkBatches.length)self.postMessage({type:'job-profile',value:{pid:id,phase:'scheduler-check-batches',at:performance.now(),ms:Math.max(0,...checkBatches.map(row=>(row.endAt??performance.now())-row.at)),jobs:checkBatchCount,dropped:checkBatchCount-checkBatches.length,checkBatches}})
      if(workerMessageTiming?.samples.length)self.postMessage({type:'job-profile',value:{pid:id,phase:'worker-message-timing',at:performance.now(),ms:Math.max(0,...workerMessageTiming.samples.map(sample=>sample.waitMs??0)),jobs:workerMessageTiming.samples.length,workerMessages:workerMessageTiming.samples}})
      const completions=engineAccess.snapshot()
      self.postMessage({type:'job-profile',value:{pid:id,phase:'passive-scheduling-summary',at:performance.now(),ms:Math.max(fiberTiming.maxMs,completions?.maxWaitMs??0),jobs:diagnostics.jobs,fiberTiming,completions,jobBatchLimit:options.profileJobs?1:100}})
      const totals:[string,number,number][]=[['execution-total',performance.now()-started,1],['job-pump-total',diagnostics.jobPumpMs,diagnostics.jobs],['file-call-total',diagnostics.fileCallMs,diagnostics.fileCalls],['yield-wait-total',diagnostics.yieldWaitMs,diagnostics.yieldCount]]
      if(diagnostics.startup)for(const [phase,ms] of Object.entries(diagnostics.startup))totals.push(['startup-'+phase,ms,1])
      for(const [phase,ms,jobs] of totals)self.postMessage({type:'job-profile',value:{pid:id,phase,at:performance.now(),ms,jobs}})
    }
    if(scheduling)self.postMessage({type:'job-profile',value:{pid:id,phase:'scheduling-summary',at:performance.now(),ms:performance.now()-started,jobs:0,scheduling}})
    try{for(const [fd,decoder] of outputDecoders)emitOutput(fd===2?'error':'log',decoder.decode(),new Uint8Array())}catch(error){failure??=String(error)}
    if(failure&&record.capture&&!record.signal){try{
      if(record.input.worker){
        const source=failureCause instanceof Error?failureCause:Error(failure),code=(source as Error&{code?:unknown}).code
        processes.emit(record,{type:'error',error:record.workerError??{name:source.name,message:source.message,stack:source.stack,code:typeof code==='string'?code:undefined}})
      }else processes.emit(record,{type:'stderr',bytes:new TextEncoder().encode(failure)})
    }catch{/* Queue limits must not prevent runtime cleanup. */}}
    try{await closeBundlerProcess()}catch(error){failure??='Native bundler cleanup failed: '+String(error)}
    try{await closeCallableProcess()}catch(error){failure??='Native callable cleanup failed: '+String(error)}
    activeHostTaskTraces.delete(id)
    disposed=true;candidate?.close();engineAccess.close();record.stdinRef=false;record.wake=undefined;record.receiveOutput=undefined;record.stdin.cancelRead(id);unsubscribe();scheduler.close()
    sharedSender?.dispose();moduleSender?.dispose();processes.finishWorkerData(record)
    network.release(id)
    datagrams.release(id)
    descriptors!.closeOwner(id)
    intl.close()
    try{await tls.closeOwner(id)}catch(error){failure??='TLS cleanup failed: '+String(error)}
    try{await http2.closeOwner(id)}catch(error){failure??='HTTP/2 cleanup failed: '+String(error)}
    for(const deferred of networkPromises)deferred.dispose()
    for(const {timer,deferred} of timers.values()){clearTimeout(timer);deferred.dispose()}
    for(const {deferred} of immediates.values())deferred.dispose()
    for(const watcher of watchers.values())watcher.pending?.dispose()
    guestSamplingBoundaries?.flush()
    guestSampling?.close()
    try{moduleLoadHook?.dispose();moduleResolveHook?.dispose();fiberJobs?.dispose();drainTicks.dispose();jobLimit.dispose();executeJobs.dispose();context.dispose();runtime.dispose()}
    catch(error){throw new Error((failure?failure+'\n'+(failureCause instanceof Error&&failureCause.stack?failureCause.stack+'\n':''):'')+'Kernel cleanup failed: '+String(error))}
  }
  return {exitCode:failure?failureExitCode:requestedExit??(failureCause as {exitCode?:number})?.exitCode??0,stdout,stderr:stderr+(failure??''),duration:performance.now()-started,wasmHeapBytes:engine.getWasmMemory().buffer.byteLength,...(diagnostics?{diagnostics}:{})}
}
