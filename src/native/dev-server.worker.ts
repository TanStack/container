import {connectVirtual,network,virtualListeningPorts} from '../vite-browser/runtime-host'
import {captureNativeNetworkFailure} from './network-failure-diagnostics'
import {observeViteRequests} from './vite-request-observation'
import {resolveWorkingDirectory,assertCanChangeDirectory} from './working-directory'
import {resolveWorkerEntry} from './worker-entry'
import {dataModuleId,dataModuleURL} from './data-module'
import {NativeSharedInputSource,setProcessInputSource} from './shared-input-source'
import {getProcessDirectory,initializeProcessDirectory} from './shared-working-directory'
import {createIpcMessageQueue} from './ipc-message-queue'
import {connectWorkerPort} from './worker-network'
import {readNativeDevScript} from './project-script'
import {isNativeTypecheck,isNativeViteBuild,isNativeViteDev,nativeViteDevOptions} from './command-classification'
import {runNativeTerminalShell} from './terminal-shell'
import {NativeTerminalSession} from './terminal-session'
import {NativeTerminalFileSession} from './terminal-file-session'
import {nativeTerminalCommandNames} from './terminal-processes'
import {checkTypeScript} from './typescript-check'
import type * as TypeScript from 'typescript'
import {createFetchEntryServer} from './fetch-entry-server'
import {resetVolume,readFileSync,readVolume,restoreVolumeSnapshot,snapshotVolume,vol,setNativeSyncFileClient,existsSync,statSync} from '../vite-browser/node-fs'
import {NativeSyncFileClient} from './sync-file-bridge'
import {NativeSyncPortClient} from './sync-port-bridge'
import type {WorkspaceSnapshot} from '../sandbox/files'
import {VolumeFileSystem} from './volume-file-system'
import {getNativeFilesystemProvider} from './filesystem-provider.mjs'
import {installLiveLockedPackages} from './live-package-install'
import {installLockedPackages,PackageInstallCache} from '../npm/install'
import {planProjectInstall,resolveProjectLock} from '../npm/project'
import {nativeInstallResult} from './install-result'
import type {ProjectInstallResult} from '../npm/project'
import type {PackageIdentity,RuntimeLock} from '../npm/types'
import {normalizePath} from '../fs/path'
import {transformSync} from '@babel/core'
import {ESModulesEvaluator} from 'vite/module-runner'
import * as nodeUrl from '../vite-browser/node-url'
import * as nodePath from '../vite-browser/node-path'
import * as nodePathPosix from '../vite-browser/node-path-posix'
import * as nodeFs from '../vite-browser/node-fs'
import * as nodeFsPromises from '../vite-browser/node-fs-promises'
import * as nodeCrypto from '../vite-browser/node-crypto'
import * as nodeModule from '../vite-browser/node-module'
import * as nodeOs from 'os-browserify/browser'
import {availableParallelism} from './available-parallelism'
import * as nodeUtil from '../vite-browser/node-util'
import * as nodeConsole from '../vite-browser/node-console'
import * as nodeBuffer from 'buffer'
import * as nodeEvents from '../vite-browser/node-events'
import * as nodeProcess from 'process/browser'
import browserProcess from 'process/browser'
import * as nodeAssert from 'assert'
import * as nodeStubs from '../vite-browser/node-stubs'
import * as nodeDns from '../vite-browser/node-dns'
import * as nodeNet from '../sandbox/guest-net.js'
import * as nodeTls from '../vite-browser/node-tls'
import * as nodeTty from 'tty-browserify'
import * as nodeV8 from '../vite-browser/node-v8'
import * as nodeWasi from '../vite-browser/node-wasi'
import * as nodeHttp from '../sandbox/guest-http.js'
import * as nodeHttps from 'https-browserify'
import * as nodeReadline from '../vite-browser/node-readline'
import * as nodeQuerystring from 'querystring-es3'
import * as nodeZlib from '../vite-browser/node-zlib'
import * as nodeTimersPromises from '../vite-browser/node-timers-promises'
import * as nodeStream from 'stream-browserify'
import '../vite-browser/install-stream-interop'
import * as nodeStreamWeb from '../vite-browser/node-stream-web'
import * as nodeStreamPromises from '../vite-browser/node-stream-promises'
import * as nodeHttp2 from '../vite-browser/node-http2'
import * as nodeVm from '../vite-browser/node-vm'
import * as nodeAsyncHooks from './async-context'
import nodeChildProcess from './child-process'
import {ipcMessage} from './ipc-message'
import {launchConditions,parseLaunchFlags} from './launch-conditions'
import {beginNodeCommandTimerActivity,trackNodeCommandPromise,keepNodeCommandAlive} from '../vite-browser/node-timers'
import {awaitModuleEvaluation,UnsettledTopLevelAwait,ModuleLoadLifetime} from './module-lifetime'
import {NativeProcessExit,isNativeProcessExit} from './process-exit'
import {formatCommandError} from './format-command-error'
import {normalizeSourceError} from './source-error'
import * as nodeWorkerThreads from './worker-threads'
import {createInlinedModuleFunction} from './inlined-module-function'
import {createBrowserModuleFunction} from './browser-module-function'
import {workerSourceLocations,enableBrowserSourceLocations} from './browser-source-locations'
import {installBrowserErrorConstructor} from './browser-error-constructor'
import {browserInlineSourceMap} from './browser-inline-source-map'
import {TraceMap,originalPositionFor} from '@jridgewell/trace-mapping'
import {lightningcssPackageRoot,prepareLightningcss,preparedLightningcss} from './browser-lightningcss'
import {disposeOxideWorkers,oxidePackageRoot,prepareOxide,preparedOxide} from './browser-oxide'
import {disposeBrowserRolldown} from './browser-rolldown-lifecycle'
import {browserEsbuild} from './browser-esbuild'
import * as browserPrettier from '../vite-browser/prettier'
import {init as initCommonJSLexer,parse as parseCommonJS} from 'cjs-module-lexer'
import {BrowserCommonJS} from './commonjs'
import {resolveVolumeImport,volumeResolver,isContainerModulePath} from './volume-resolver'
import {volumeBuildLoader} from './volume-build-loader'
import {setRuntimeWorkspaceImporter} from './runtime-module-import'
import {installBrowserModuleFetch} from './runnable-loader'
import {trackIpcChannelLifetime} from './ipc-channel-lifetime'
import {NativeStdioTransport} from './stdio-transport'
import {NativeInputLifetime} from './input-lifetime'
import {asyncContextTransform} from './async-context-transform'
import {resolveRuntimeAssetBase} from '../sandbox/runtime-assets'
import type {Plugin} from 'vite'

// Vite serves source modules in development mode. The shared compiler engine
// defaults to production for builds, so select this worker's own process mode.
const nativeCommandWorker=new URL(self.location.href).searchParams.has('native-command')
const nativeWorkerThread=new URL(self.location.href).searchParams.has('native-thread')
let nativeRuntimeAssetBaseURL=new URL('/runtime/',self.location.href).href
const stdioTransport=new NativeStdioTransport(message=>self.postMessage(message),keepNodeCommandAlive)
browserProcess.env.NODE_ENV='development'
Object.assign(browserProcess,{platform:'linux',arch:'x64',execPath:'/usr/bin/node'})
if(!nativeCommandWorker){
  // App and ordinary thread runtimes have no attached input channel.
  // They still own a readable stdin descriptor, already at EOF.
  const source=new NativeSharedInputSource()
  void source.write(null)
  setProcessInputSource(source)
  const stdin=new nodeStream.Readable({read(){
    void source.read(this).then(bytes=>this.push(bytes===null?null:nodeBuffer.Buffer.from(bytes)),error=>this.destroy(error))
  }})
  Object.assign(stdin,{isTTY:false,fd:0})
  Object.assign(browserProcess,{stdin})
}
for(const [name,write] of [['stdout',console.log],['stderr',console.error]] as const){
  const decoder=new TextDecoder()
  const publish=(value:string)=>{
    if(value&&!nativeWorkerThread&&!nativeCommandWorker){
      write(value)
      self.postMessage({type:'native-dev-output',stream:name,text:value})
    }
  }
  const stream=new nodeStream.Writable({write(chunk:Uint8Array,_encoding:string,callback:(error?:Error)=>void){
    publish(decoder.decode(chunk instanceof Uint8Array?chunk:new Uint8Array(chunk),{stream:true}))
    if(nativeWorkerThread||nativeCommandWorker)stdioTransport.write(name,new Uint8Array(chunk),callback)
    else callback()
  },final(callback:()=>void){
    publish(decoder.decode())
    callback()
  }})
  Object.assign(stream,{isTTY:false})
  Object.assign(browserProcess,{[name]:stream})
}
if(!nativeCommandWorker){
  const processOutput=browserProcess as typeof browserProcess & {
    stdout:{write(value:string):void};stderr:{write(value:string):void}
  }
  const output=(...args:unknown[])=>processOutput.stdout.write(nodeUtil.format(...args)+'\n')
  const error=(...args:unknown[])=>processOutput.stderr.write(nodeUtil.format(...args)+'\n')
  console.log=output
  console.info=output
  console.debug=output
  console.warn=error
  console.error=error
}
Object.assign(globalThis,{process:browserProcess})
initializeProcessDirectory('/app')
browserProcess.cwd=()=>getProcessDirectory().read()
browserProcess.chdir=(directory:string)=>{
  assertCanChangeDirectory(new URL(self.location.href).searchParams.has('native-thread'))
  getProcessDirectory().write(resolveWorkingDirectory(browserProcess.cwd(),directory,nodeFs))
}

type Socket=Awaited<ReturnType<typeof connectVirtual>>
type DevServer=Awaited<ReturnType<typeof import('vite')['createServer']>>
const sockets=new Map<number,Socket>()
const captureReset=(error:unknown)=>{
  // Recording must not replace the original browser error or rejection.
  try{captureNativeNetworkFailure(error,()=>network.snapshot())}catch{}
}
self.addEventListener('unhandledrejection',(event)=>{
  const error=event.reason
  captureReset(error)
  if(isNativeProcessExit(error)){event.preventDefault();return}
  if(nativeWorkerThread){
    event.preventDefault()
    self.postMessage({type:'native-thread-error',error:formatCommandError(error),diagnostic:{handles:network.snapshot(),code:error?.code}})
    self.close()
    return
  }
  self.postMessage({type:'native-dev-diagnostic',error:String(error),stack:error?.stack,diagnostic:{handles:network.snapshot(),code:error?.code}})
})
self.addEventListener('error',(event)=>{
  captureReset(event.error)
  if(isNativeProcessExit(event.error)){event.preventDefault();return}
  if(nativeWorkerThread){
    event.preventDefault()
    self.postMessage({type:'native-thread-error',error:formatCommandError(event.error??Error(event.message)),diagnostic:{handles:network.snapshot(),code:event.error?.code}})
    self.close()
    return
  }
  event.preventDefault()
  self.postMessage({type:'native-dev-fatal',error:event.message,stack:event.error?.stack,diagnostic:{handles:network.snapshot(),code:event.error?.code}})
  self.close()
})
const maxConnections=128
let pendingConnections=0
const connectionWaiters=new Set<()=>void>()
let viteRequestObservation: ReturnType<typeof observeViteRequests> | undefined
let viteRequestObservationTimer: ReturnType<typeof setInterval> | undefined
const wakeConnectionWaiter=()=>{
  const next=connectionWaiters.values().next().value
  if(next){connectionWaiters.delete(next);next()}
}
let workerConditions:string[]=[]
const commonJS=new BrowserCommonJS(resolved=>{
  const oxideRoot=oxidePackageRoot(resolved)
  if(oxideRoot&&resolved.endsWith('/index.js'))return preparedOxide(oxideRoot)
  const packageRoot=lightningcssPackageRoot(resolved)
  return packageRoot&&/\/node\/index\.(?:js|mjs)$/.test(resolved)?preparedLightningcss(packageRoot):undefined
},(specifier,from)=>{
  const requested=specifier.startsWith('file:')?nodeUrl.fileURLToPath(specifier):specifier
  const resolved=resolveVolumeImport(requested,from,'server',workerConditions)
  if(!resolved)throw Error(`Cannot resolve dynamic import ${specifier} from ${from}`)
  const release=keepNodeCommandAlive()
  return (async()=>{
    try{if(nativeCommandWorker)await ensureThreadEnvironment()}
    finally{release()}
    if(!configEnvironment||!('runner' in configEnvironment))throw Error('Module runner is unavailable')
    return threadModuleLoads.load(resolved,()=>configEnvironment!.runner.import(resolved))
  })()
},true,()=>workerConditions)
let configEnvironment:{close():Promise<void>;runner:{import(id:string):Promise<unknown>}}|undefined
let refreshFetchEntry:(()=>Promise<void>)|undefined
const threadModuleLoads=new ModuleLoadLifetime(keepNodeCommandAlive)
setRuntimeWorkspaceImporter(async(specifier)=>{
  const path=specifier.startsWith('file:')?nodeUrl.fileURLToPath(specifier):specifier
  if(!isContainerModulePath(path))throw Error('Module import is outside the container filesystem')
  const release=keepNodeCommandAlive()
  try{if(!configEnvironment)await ensureThreadEnvironment()}
  finally{release()}
  return threadModuleLoads.load(path,()=>configEnvironment!.runner.import(path))
})
let commandActivity:ReturnType<typeof beginNodeCommandTimerActivity>|undefined
let threadEnvironmentPromise:Promise<void>|undefined
let commonJSBridgePromise:Promise<void>|undefined
function ensureCommonJSBridge(){
  if(!commonJSBridgePromise)commonJSBridgePromise=(async()=>{
    await initCommonJSLexer()
    Object.defineProperty(globalThis,Symbol.for('web-container:commonjs'),{
      value:(filename:string)=>commonJS.load(filename),configurable:true,
    })
  })()
  return commonJSBridgePromise
}
const commandSourceModules=new Map<string,string>()
let commandEvaluationStarted:(()=>void)|undefined
const commandSourcePlugin={name:'native-command-source',enforce:'pre' as const,
  resolveId(id:string){return commandSourceModules.has(id)?id:undefined},
  load(id:string){return commandSourceModules.get(id)},
}
function traceModuleFetch(phase:'start'|'end',id:string){
  if(browserProcess.env.NATIVE_MODULE_TRACE==='1')self.postMessage({type:'native-dev-progress',phase:`module-fetch-${phase}:${id}`})
}
async function ensureThreadEnvironment(){
  if(!threadEnvironmentPromise)threadEnvironmentPromise=(async()=>{
    await ensureCommonJSBridge()
    const {createRunnableDevEnvironment,resolveConfig}=await import('vite')
    const config=await resolveConfig({root:'/app',configFile:false,envDir:false,cacheDir:'/app/.vite',plugins:[commandSourcePlugin,volumeResolver(),commonJSPlugin,asyncContextTransform()],environments:{inline:{consumer:'server',dev:{moduleRunnerTransform:true},resolve:{noExternal:true,conditions:['node','module','import','default',...workerConditions]}}}},'serve')
    const environment=createRunnableDevEnvironment('inline',config,{runnerOptions:{hmr:false,evaluator:new BrowserModuleEvaluator(threadModuleLoads)},hot:false})
    configEnvironment=environment
    installBrowserModuleFetch(environment,(phase,id,handle)=>{
      commandActivity?.track(handle,phase==='start',`module ${id}`)
      traceModuleFetch(phase,id)
    })
    await environment.init()
  })()
  return threadEnvironmentPromise
}
const auxiliaryServers=new Set<DevServer>()
const volumeScanPlugin={
  name:'browser-native-volume-scan',
  resolveId(id:string,importer?:string){
    if(id.startsWith('node:')||id.startsWith('\0')||/\.(?:css|html|astro|svelte|vue)(?:\?|$)/.test(id))return
    return resolveVolumeImport(id,importer?.startsWith('/app/')?importer:'/app/__entry__.js','client')
  },
  load(id:string){
    const path=id.split('?')[0]
    if(!/^\/app\/.+\.(?:[cm]?[jt]sx?|json)$/.test(path)||!existsSync(path)||!statSync(path).isFile())return
    return readFileSync(path,'utf8') as string
  },
}
const volumeOptimizerPlugin={name:'browser-native-volume-optimizer',configResolved(config:unknown){
  const c=config as {environments?:Record<string,{optimizeDeps?:{rolldownOptions?:{plugins?:unknown[]}}}>}
  for(const environment of Object.values(c.environments??{})){
    const optimizeDeps=environment.optimizeDeps??(environment.optimizeDeps={})
    const rolldownOptions=optimizeDeps.rolldownOptions??(optimizeDeps.rolldownOptions={})
    const plugins=rolldownOptions.plugins??[]
    if(!plugins.some(plugin=>(plugin as {name?:string})?.name===volumeScanPlugin.name))
      rolldownOptions.plugins=[volumeScanPlugin,...plugins]
  }
}}
const workspaceResolvedConfigs=new WeakSet<object>()
async function workspaceViteConfig(inlineConfig:Record<string,unknown>={}){
  const vite=await import('vite')
  let userConfig:Record<string,unknown>={}
  const configPath=['/app/vite.config.ts','/app/vite.config.js','/app/vite.config.mts','/app/vite.config.mjs'].find(path=>nodeFs.existsSync(path))
  if(configPath){
    const runner=(configEnvironment as {runner?:{import:(path:string)=>Promise<{default:unknown}>}}|undefined)?.runner
    if(!runner)throw Error('Workspace module runner is unavailable for Vite config')
    const exported=(await runner.import(configPath)).default
    userConfig=typeof exported==='function'
      ?await exported({command:'serve',mode:'development',isSsrBuild:false,isPreview:false})
      :exported as Record<string,unknown>
    if(!userConfig||typeof userConfig!=='object')throw Error('Vite config must export an object')
  }
  const merged=vite.mergeConfig(userConfig,inlineConfig)
  const browserRunnerPlugin={
    name:'browser-workspace-module-runner',
    configureServer(created:DevServer){
      for(const environment of Object.values(created.environments)){
        if(!vite.isRunnableDevEnvironment(environment))continue
        installBrowserModuleFetch(environment,(phase,id,handle)=>{
          commandActivity?.track(handle,phase==='start',`vite module ${id}`)
          traceModuleFetch(phase,id)
        })
        environment.runner.evaluator=new BrowserModuleEvaluator()
      }
      created.ssrLoadModule=async (url)=>{
        const environment=created.environments.ssr
        if(!vite.isRunnableDevEnvironment(environment))throw Error('Runnable SSR environment is unavailable')
        return trackNodeCommandPromise(environment.runner.import(url))
      }
    },
  }
  const plugins=[volumeResolver(),commonJSPlugin,asyncContextTransform(),volumeOptimizerPlugin,browserRunnerPlugin,...(Array.isArray(merged.plugins)?merged.plugins:[])]
  const optimizeDeps=merged.optimizeDeps as {rolldownOptions?:{plugins?:unknown[]}}|undefined
  const nativeConfig={...merged,root:'/app',configFile:false,plugins,
    optimizeDeps:{...optimizeDeps,rolldownOptions:{...optimizeDeps?.rolldownOptions,
      plugins:[volumeScanPlugin,...(optimizeDeps?.rolldownOptions?.plugins??[])]}}}
  return nativeConfig
}
async function resolveWorkspaceViteConfig(args:Parameters<typeof import('vite')['resolveConfig']>){
  const vite=await import('vite')
  const [inlineConfig,...rest]=args
  const config=await workspaceViteConfig(inlineConfig as Record<string,unknown>)
  const resolved=await vite.resolveConfig(...[config,...rest] as Parameters<typeof vite.resolveConfig>)
  workspaceResolvedConfigs.add(resolved)
  return resolved
}
async function createWorkspaceViteServer(inlineConfig:Record<string,unknown>={}){
  const vite=await import('vite')
  // Preserve Vite's resolved config and plugin-hook caches. Re-merging it
  // converts computed fields such as assetsInclude back into raw input.
  const config=workspaceResolvedConfigs.has(inlineConfig)?inlineConfig:await workspaceViteConfig(inlineConfig)
  const created=await vite.createServer(config as Parameters<typeof vite.createServer>[0])
  auxiliaryServers.add(created)
  return created
}
function commonJSExportNames(source:string,id:string,seen=new Set<string>()):Set<string>{
  if(seen.has(id))return new Set()
  seen.add(id)
  const parsed=parseCommonJS(source)
  const names=new Set(parsed.exports)
  for(const specifier of parsed.reexports){
    if(!specifier.startsWith('.'))continue
    const candidate=nodePath.join(nodePath.dirname(id),specifier)
    const path=[candidate,candidate+'.js',candidate+'.cjs'].find(path=>nodeFs.existsSync(path))
    if(path&&commonJS.isCommonJS(path))
      for(const name of commonJSExportNames(nodeFs.readFileSync(path,'utf8') as string,path,seen))names.add(name)
  }
  return names
}
const commonJSPlugin:Plugin={
  name:'browser-native-commonjs',
  enforce:'pre',
  async transform(source,id,options){
    if(!isContainerModulePath(id)||!commonJS.isCommonJS(id))return
    if(this.environment?.mode==='build')return
    const serverSide=options?.ssr||this.environment?.config.consumer==='server'
    const loaded=serverSide?commonJS.load(id):undefined
    const names=[...new Set([...commonJSExportNames(source,id),...(loaded&&typeof loaded==='object'?Object.keys(loaded):[])])]
      .filter(name=>/^[A-Za-z_$][\w$]*$/.test(name)&&name!=='default')
    const named=names.map((name,index)=>`const __cjs_export_${index}=__cjs[${JSON.stringify(name)}];export {__cjs_export_${index} as ${name}};`).join('\n')
    if(serverSide)return `const __cjs=globalThis[Symbol.for('web-container:commonjs')](${JSON.stringify(id)});export default __cjs;\n${named}`
    const dependencies=new Set<string>()
    transformSync(source,{babelrc:false,configFile:false,sourceType:'script',filename:id,
      parserOpts:{allowReturnOutsideFunction:true},plugins:[()=>({visitor:{CallExpression(path:any){
        const call=path.node
        if(call.callee.type==='Identifier'&&call.callee.name==='require'&&
          call.arguments.length===1&&call.arguments[0]?.type==='StringLiteral'&&
          !path.scope.hasBinding('require'))dependencies.add(call.arguments[0].value)
      }}})]})
    const imports:string[]=[]
    const entries:string[]=[]
    for(const [index,specifier] of [...dependencies].entries()){
      const resolved=await this.resolve(specifier,id,{skipSelf:true})
      if(!resolved||resolved.external)throw Error(`Cannot resolve browser CommonJS dependency ${specifier} from ${id}`)
      imports.push(`import * as __cjs_import_${index} from ${JSON.stringify(resolved.id)};`)
      entries.push(`${JSON.stringify(specifier)}:('default' in __cjs_import_${index}?__cjs_import_${index}.default:__cjs_import_${index})`)
    }
    return `${imports.join('\n')}\nconst __cjs_deps={${entries.join(',')}};const __cjs_module={exports:{}};const __cjs_require=(id)=>{if(!Object.hasOwn(__cjs_deps,id))throw Error('Dynamic CommonJS require is unavailable: '+id);return __cjs_deps[id]};(function(exports,require,module,__filename,__dirname){\n${source}\n})(__cjs_module.exports,__cjs_require,__cjs_module,${JSON.stringify(id)},${JSON.stringify(id.slice(0,id.lastIndexOf('/')))});const __cjs=__cjs_module.exports;export default __cjs;\n${named}`
  },
}
const browserBuiltins:Record<string,unknown>={
  'node:console':nodeConsole,
  'node:url':nodeUrl,'node:path':nodePath,'node:path/posix':nodePathPosix,'node:fs':nodeFs,
  'node:fs/promises':nodeFsPromises,'node:crypto':nodeCrypto,
  'node:module':nodeModule,'node:os':{...nodeOs,availableParallelism,
    default:{...((nodeOs as typeof nodeOs & {default?:object}).default??nodeOs),availableParallelism}},'node:util':nodeUtil,
  'node:buffer':nodeBuffer,'node:events':nodeEvents,'node:process':{...nodeProcess,...browserProcess,default:browserProcess},
  'node:assert':nodeAssert,'node:assert/strict':nodeAssert,
  'node:perf_hooks':{performance:nodeStubs.performance},
  'node:worker_threads':nodeWorkerThreads,
  'node:child_process':nodeChildProcess,
  'node:dns':nodeDns,
  'node:net':nodeNet,
  'node:tls':nodeTls,
  'node:tty':nodeTty,
  'node:v8':nodeV8,
  'node:wasi':nodeWasi,
  'node:http':nodeHttp,
  'node:https':nodeHttps,
  'node:readline':nodeReadline,
  'node:querystring':nodeQuerystring,
  'node:zlib':nodeZlib,
  'node:timers/promises':nodeTimersPromises,
  'node:timers':{setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout,
    setInterval:globalThis.setInterval,clearInterval:globalThis.clearInterval,
    setImmediate:globalThis.setImmediate,clearImmediate:globalThis.clearImmediate},
  'node:stream':nodeStream,
  'node:stream/web':nodeStreamWeb,
  'node:stream/promises':nodeStreamPromises,
  'node:http2':nodeHttp2,
  'node:vm':nodeVm,
  'node:async_hooks':{AsyncLocalStorage:nodeAsyncHooks.NativeAsyncLocalStorage,
    AsyncResource:nodeAsyncHooks.NativeAsyncResource,executionAsyncId:nodeAsyncHooks.executionAsyncId},
}
// Evaluators share this worker realm. Older callbacks need their original maps,
// and every evaluator must observe the same global Error constructor.
let workerMappedError:ErrorConstructor|undefined
class BrowserModuleEvaluator extends ESModulesEvaluator{
  private sourceLocations=workerSourceLocations
  private dataModuleImporter:((id:string)=>Promise<unknown>)|undefined
  setDataModuleImporter(importer:(id:string)=>Promise<unknown>){this.dataModuleImporter=importer}
  constructor(private readonly moduleLoads=new ModuleLoadLifetime(keepNodeCommandAlive)){super()}
  async runInlinedModule(context:any,code:string){
    const meta=context.__vite_ssr_import_meta__ as {filename:string;url:string;resolve?:(id:string,parent?:string)=>string}|undefined
    const moduleId=meta?.filename??'/app/__evaluated__.mjs'
    const dataURL=dataModuleURL(moduleId)
    if(meta&&dataURL)meta.url=dataURL
    this.moduleLoads.evaluating(moduleId)
    for(const name of ['__vite_ssr_import__','__vite_ssr_dynamic_import__']){
      const importModule=context[name] as ((...args:unknown[])=>Promise<unknown>)|undefined
      if(importModule)context[name]=(...args:unknown[])=>{
        const specifier=typeof args[0]==='string'?args[0]:''
        if(dataURL&&!nodeModule.isBuiltin(specifier)&&!specifier.startsWith('data:'))
          throw Object.assign(Error(`Cannot resolve ${specifier} from a data URL`),{code:'ERR_UNSUPPORTED_RESOLVE_REQUEST'})
        const requested=specifier.startsWith('file:')?nodeUrl.fileURLToPath(specifier):specifier
        const target=resolveVolumeImport(requested,moduleId,'server',workerConditions)??requested
        const importArgs=requested===specifier?args:[requested,...args.slice(1)]
        return this.moduleLoads.load(target,()=>Promise.resolve(importModule(...importArgs)))
      }
    }
    if(meta)meta.resolve=(specifier,parent)=>{
      if(nodeModule.isBuiltin(specifier))return specifier.startsWith('node:')?specifier:`node:${specifier}`
      if(specifier.startsWith('data:'))return specifier
      if(dataURL)throw Object.assign(Error(`Cannot resolve ${specifier} from a data URL`),{code:'ERR_UNSUPPORTED_RESOLVE_REQUEST'})
      const importer=parent?(parent.startsWith('file:')?nodeUrl.fileURLToPath(parent):parent):meta.filename
      const resolved=resolveVolumeImport(specifier,importer)
      if(!resolved)throw Error(`Cannot resolve ${specifier} from ${importer}`)
      if(nodeModule.isBuiltin(resolved))return resolved.startsWith('node:')?resolved:`node:${resolved}`
      return nodeUrl.pathToFileURL(resolved).href
    }
    const names=Object.keys(context)
    const trace=browserProcess.env.NATIVE_MODULE_TRACE==='1'
    if(trace)self.postMessage({type:'native-dev-progress',phase:`module-evaluate-start:${moduleId}`})
    const guestFunction=commonJS.createFunctionConstructor(meta?.filename??'/app/__evaluated__.mjs')
    let evaluate:(...values:unknown[])=>Promise<unknown>
    if(browserProcess.env.NATIVE_BROWSER_MODULES==='1'){
      workerMappedError??=installBrowserErrorConstructor(globalThis,stack=>workerSourceLocations.mapStack(stack))
      enableBrowserSourceLocations()
      const compiled=await createBrowserModuleFunction(names,code,guestFunction,workerMappedError)
      compiled.dispose()
      const inlineMap=browserInlineSourceMap(code)
      if(inlineMap){
        const traced=new TraceMap(inlineMap as any)
        const sourceTrace=browserProcess.env.NATIVE_SOURCE_MAP_TRACE==='1'
        if(sourceTrace)console.error('SOURCE_MAP_INPUT',JSON.stringify({moduleId,startOffset:compiled.startOffset,code:code.slice(0,1200),map:inlineMap}))
        this.sourceLocations.register(compiled.url,(line,column)=>{
          const mapped=originalPositionFor(traced,{line:line-compiled.startOffset+this.startOffset,column:column-1})
          if(sourceTrace)console.error('SOURCE_MAP_POSITION',JSON.stringify({moduleId,line,column,mapped}))
          if(mapped.source===null||mapped.line===null||mapped.column===null)return null
          const file=nodeUrl.fileURLToPath(new URL(mapped.source,nodeUrl.pathToFileURL(moduleId).href))
          return {file,line:mapped.line,column:mapped.column+1}
        })
      }
      evaluate=compiled.evaluate
    }else evaluate=createInlinedModuleFunction(names,code,guestFunction)
    commandEvaluationStarted?.()
    await evaluate(...names.map(name=>context[name]))
    if(trace)self.postMessage({type:'native-dev-progress',phase:`module-evaluate-end:${moduleId}`})
    Object.seal(context.__vite_ssr_exports__)
  }
  async runExternalModule(file:string):Promise<any>{
    if(file.startsWith('data:')){
      if(!this.dataModuleImporter)throw Error('Data module importer is not initialized')
      return this.dataModuleImporter(dataModuleId(file))
    }
    if(file.startsWith('browser-native:lightningcss:')){
      const packageRoot=decodeURIComponent(file.slice('browser-native:lightningcss:'.length))
      await prepareLightningcss([packageRoot])
      return preparedLightningcss(packageRoot)
    }
    if(file.startsWith('browser-native:oxide:')){
      const packageRoot=decodeURIComponent(file.slice('browser-native:oxide:'.length))
      await prepareOxide([packageRoot])
      return preparedOxide(packageRoot)
    }
    if(file==='browser-native:prettier'||file.startsWith('browser-native:prettier:')){
      const packageRoot=file==='browser-native:prettier'?'/app/node_modules/prettier':decodeURIComponent(file.slice('browser-native:prettier:'.length))
      const packageJson=JSON.parse(nodeFs.readFileSync(packageRoot+'/package.json','utf8') as string) as {version:string}
      if(packageJson.version!==__BROWSER_PRETTIER_VERSION__)
        throw Error(`Browser Prettier ${__BROWSER_PRETTIER_VERSION__} does not match installed Prettier ${packageJson.version}`)
      return browserPrettier
    }
    if(file.startsWith('browser-native:esbuild:'))
      return browserEsbuild(decodeURIComponent(file.slice('browser-native:esbuild:'.length)))
    if(file==='browser-native:vite'){
      const packageJson=JSON.parse(nodeFs.readFileSync('/app/node_modules/vite/package.json','utf8') as string) as {version:string}
      if(packageJson.version!==__BROWSER_VITE_VERSION__)
        throw Error(`Browser Vite ${__BROWSER_VITE_VERSION__} does not match installed Vite ${packageJson.version}`)
      const vite=await import('vite')
      const withWorkspace=(config:Parameters<typeof vite.createBuilder>[0])=>vite.mergeConfig(config??{},
        {plugins:[volumeResolver(),volumeBuildLoader()]})
      const createBrowserBuilder=async(config:Parameters<typeof vite.createBuilder>[0])=>{
        const builder=await vite.createBuilder(withWorkspace(config))
        for(const environment of Object.values(builder.environments)){
          const outDir=environment.config.build.outDir
          if(!nodePath.isAbsolute(outDir))environment.config.build.outDir=nodePath.resolve('/app',outDir)
        }
        const originalBuild=builder.build.bind(builder)
        builder.build=environment=>trackNodeCommandPromise((async()=>{
          const result=await originalBuild(environment)
          const buildOptions=environment.config.build as typeof environment.config.build & {
            rolldownOptions?:{output?:{dir?:string}|Array<{dir?:string}>}
            rollupOptions?:{output?:{dir?:string}|Array<{dir?:string}>}
          }
          for(const [index,output] of (Array.isArray(result)?result:[result]).entries()){
            if(!output||!('output' in output))continue
            const configuredOutput=buildOptions.rolldownOptions?.output??buildOptions.rollupOptions?.output
            const outputOptions=Array.isArray(configuredOutput)?configuredOutput[index]:configuredOutput
            const directory=nodePath.resolve('/app',outputOptions?.dir??environment.config.build.outDir)
            if(directory!=='/app'&&!directory.startsWith('/app/'))throw Error(`Build output escaped workspace: ${directory}`)
            for(const file of output.output){
              const path=nodePath.resolve(directory,file.fileName)
              if(!path.startsWith(directory+'/'))throw Error(`Build output escaped directory: ${file.fileName}`)
              nodeFs.mkdirSync(nodePath.dirname(path),{recursive:true})
              nodeFs.writeFileSync(path,file.type==='chunk'?file.code:file.source)
            }
          }
          return result
        })())
        const originalBuildApp=builder.buildApp.bind(builder)
        builder.buildApp=()=>trackNodeCommandPromise(originalBuildApp())
        return builder
      }
      return {...vite,createServer:(config:Parameters<typeof vite.createServer>[0])=>
        trackNodeCommandPromise(createWorkspaceViteServer(config as Record<string,unknown>)),
        resolveConfig:(...args:Parameters<typeof vite.resolveConfig>)=>trackNodeCommandPromise(resolveWorkspaceViteConfig(args)),
        createBuilder:(config:Parameters<typeof vite.createBuilder>[0])=>trackNodeCommandPromise(createBrowserBuilder(config)),
        build:(config:Parameters<typeof vite.build>[0])=>trackNodeCommandPromise(vite.build(withWorkspace(config)))}
    }
    if(file.startsWith('browser-native:rolldown')){
      const packageJson=JSON.parse(nodeFs.readFileSync('/app/node_modules/rolldown/package.json','utf8') as string) as {version:string}
      if(!__BROWSER_ROLLDOWN_VERSION__||packageJson.version!==__BROWSER_ROLLDOWN_VERSION__)
        throw Error(`Browser Rolldown ${__BROWSER_ROLLDOWN_VERSION__||'unavailable'} does not match installed Rolldown ${packageJson.version}`)
      switch(file){
        case 'browser-native:rolldown':{
          const browserRolldown=await import('@rolldown/browser')
          return {...browserRolldown,rolldown:async(options:Parameters<typeof browserRolldown.rolldown>[0])=>{
            if(!options||typeof options!=='object'||Array.isArray(options))return browserRolldown.rolldown(options)
            const config=options as Record<string,unknown>
            const plugins=Array.isArray(config.plugins)?config.plugins:config.plugins?[config.plugins]:[]
            const bundle=await trackNodeCommandPromise(Promise.resolve(browserRolldown.rolldown({...config,plugins:[...plugins,volumeResolver(),volumeBuildLoader()]})))
            if(!bundle||typeof bundle!=='object')return bundle
            return new Proxy(bundle,{get(target,property,receiver){
              const value=Reflect.get(target,property,receiver)
              if(typeof value!=='function'||!['generate','write','close'].includes(String(property)))return value
              if(property==='write')return (outputOptions:Record<string,unknown>)=>trackNodeCommandPromise((async()=>{
                const output=await Reflect.apply(target.generate,target,[outputOptions]) as
                  {output:Array<{fileName:string;type:string;code?:string;source?:string|Uint8Array}>}
                const root=typeof outputOptions.dir==='string'
                  ?nodePath.resolve(browserProcess.cwd(),outputOptions.dir)
                  :typeof outputOptions.file==='string'
                    ?nodePath.dirname(nodePath.resolve(browserProcess.cwd(),outputOptions.file)):undefined
                if(!root||root==='/app'||!root.startsWith('/app/'))throw Error(`Build output escaped workspace: ${root}`)
                for(const file of output.output){
                  const path=nodePath.resolve(root,file.fileName)
                  if(!path.startsWith(root+'/'))throw Error(`Build output escaped directory: ${file.fileName}`)
                  nodeFs.mkdirSync(nodePath.dirname(path),{recursive:true})
                  nodeFs.writeFileSync(path,file.type==='chunk'?file.code:file.source)
                }
                return output
              })())
              return (...args:unknown[])=>{
                const result=Reflect.apply(value,target,args)
                return result&&typeof (result as PromiseLike<unknown>).then==='function'
                  ?trackNodeCommandPromise(result as Promise<unknown>):result
              }
            }})
          }}
        }
        case 'browser-native:rolldown/parseAst':return import('@rolldown/browser/parseAst')
        case 'browser-native:rolldown/plugins':return import('@rolldown/browser/plugins')
        case 'browser-native:rolldown/experimental':return import('@rolldown/browser/experimental')
        case 'browser-native:rolldown/utils':return import('@rolldown/browser/utils')
        case 'browser-native:rolldown/filter':return import('@rolldown/browser/filter')
        case 'browser-native:rolldown/getLogFilter':return import('@rolldown/browser/getLogFilter')
        case 'browser-native:rolldown/config':return import('@rolldown/browser/config')
        case 'browser-native:rolldown/parallelPlugin':return import('@rolldown/browser/parallelPlugin')
      }
      throw Error(`Unsupported browser Rolldown module: ${file}`)
    }
    const builtin=file.startsWith('node:')?file:`node:${file}`
    if(builtin in browserBuiltins)return Promise.resolve(browserBuiltins[builtin])
    if(file.startsWith('file:'))throw Error(`File URL escaped the browser module runner: ${file}`)
    return super.runExternalModule(file)
  }
}
let nextSocket=0
let server:DevServer|undefined
let port:number|undefined
async function prepareRestartedRunnableEnvironments(running:DevServer){
  const {isRunnableDevEnvironment}=await import('vite')
  for(const environment of Object.values(running.environments)){
    if(!isRunnableDevEnvironment(environment)||environment.runner.evaluator instanceof BrowserModuleEvaluator)continue
    installBrowserModuleFetch(environment,traceModuleFetch)
    environment.runner.evaluator=new BrowserModuleEvaluator()
  }
}
const workspacePath=(path:string)=>{
  if(typeof path!=='string'||!path||path.includes('\\')||path.includes('\0'))throw Error('Invalid workspace path')
  const resolved=normalizePath(path.startsWith('/')?path:'/app/'+path)
  if(!resolved.startsWith('/app/'))throw Error('Path is outside the workspace')
  return resolved
}
const packagePath=(path:string)=>{
  if(typeof path!=='string'||path.includes('\\')||path.includes('\0'))throw Error('Invalid package path')
  const resolved=path.startsWith('/node_modules/')?'/app'+path:path
  const normalized=normalizePath(resolved)
  if(normalized!==resolved||!normalized.startsWith('/app/node_modules/'))throw Error('Package path is outside the workspace')
  return normalized
}
const packageIdentity=<T extends PackageIdentity>(pkg:T):T=>({
  ...pkg,installPath:packagePath(pkg.installPath),
})

const nestedThread=new URL(self.location.href).searchParams.has('native-thread')||nativeCommandWorker
function mountStartWorkspace(data:{files?:Record<string,string|Uint8Array>;restoreSnapshot?:WorkspaceSnapshot}){
  let paths:string[]
  if(data.restoreSnapshot){
    paths=Object.keys(data.restoreSnapshot.files)
    restoreVolumeSnapshot(data.restoreSnapshot)
    delete data.restoreSnapshot
  }else{
    const files=Object.fromEntries(Object.entries(data.files??{}).map(([path,bytes])=>[workspacePath(path),bytes]))
    paths=Object.keys(files)
    resetVolume(files)
  }
  delete data.files
  return paths.filter(path=>path.endsWith('/package.json')&&path.includes('/node_modules/')).map(path=>path.slice(0,-'/package.json'.length))
}
async function buildNativeProject(ssr:boolean,logLevel:'silent'|'info'='silent'){
  const previousNodeEnv=browserProcess.env.NODE_ENV
  browserProcess.env.NODE_ENV='production'
  let closeBuildConfig:(()=>Promise<void>)|undefined
  try{
    const vite=await import('vite')
    const configPath=['/app/vite.config.ts','/app/vite.config.js','/app/vite.config.mts','/app/vite.config.mjs'].find(path=>nodeFs.existsSync(path))
    let userConfig:Record<string,unknown>={}
    if(configPath){
      const config=await vite.resolveConfig({root:'/app',configFile:false,envDir:false,cacheDir:'/app/.vite',plugins:[volumeResolver(),commonJSPlugin,asyncContextTransform()],environments:{inline:{consumer:'server',dev:{moduleRunnerTransform:true},resolve:{noExternal:true,conditions:['node','module','import','default']}}}},'serve','production')
      const environment=vite.createRunnableDevEnvironment('inline',config,{runnerOptions:{hmr:false,evaluator:new BrowserModuleEvaluator()},hot:false})
      closeBuildConfig=()=>environment.close()
      installBrowserModuleFetch(environment,traceModuleFetch)
      await environment.init()
      const exported=(await environment.runner.import(configPath)).default
      userConfig=typeof exported==='function'
        ?await exported({command:'build',mode:'production',isSsrBuild:ssr,isPreview:false})
        :exported as Record<string,unknown>
      if(!userConfig||typeof userConfig!=='object')throw Error('Vite config must export an object')
    }
    const plugins=[volumeResolver(),volumeBuildLoader(),commonJSPlugin,asyncContextTransform(),...(Array.isArray(userConfig.plugins)?userConfig.plugins:[])]
    const before=new Set(Object.keys(readVolume('/app')))
    const written=new Set<string>()
    const builder=await vite.createBuilder({...userConfig,root:'/app',configFile:false,logLevel,plugins,
      build:{...(userConfig.build as Record<string,unknown>|undefined),ssr}})
    for(const environment of Object.values(builder.environments)){
      const outDir=environment.config.build.outDir
      if(!nodePath.isAbsolute(outDir))environment.config.build.outDir=nodePath.resolve('/app',outDir)
    }
    const originalBuild=builder.build.bind(builder)
    builder.build=async environment=>{
      const result=await originalBuild(environment)
      const buildOptions=environment.config.build as typeof environment.config.build & {
        rolldownOptions?:{output?:{dir?:string}|Array<{dir?:string}>}
        rollupOptions?:{output?:{dir?:string}|Array<{dir?:string}>}
      }
      for(const [index,output] of (Array.isArray(result)?result:[result]).entries()){
        if(!output||!('output' in output))continue
        const configuredOutput=buildOptions.rolldownOptions?.output??buildOptions.rollupOptions?.output
        const outputOptions=Array.isArray(configuredOutput)?configuredOutput[index]:configuredOutput
        const directory=nodePath.resolve('/app',outputOptions?.dir??environment.config.build.outDir)
        if(directory!=='/app'&&!directory.startsWith('/app/'))throw Error(`Build output escaped workspace: ${directory}`)
        for(const file of output.output){
          const path=nodePath.resolve(directory,file.fileName)
          if(!path.startsWith(directory+'/'))throw Error(`Build output escaped directory: ${file.fileName}`)
          nodeFs.mkdirSync(nodePath.dirname(path),{recursive:true})
          nodeFs.writeFileSync(path,file.type==='chunk'?file.code:file.source)
          written.add(path)
        }
      }
      return result
    }
    await builder.buildApp()
    const outputFiles=[...new Set([...written,...Object.keys(readVolume('/app')).filter(path=>!before.has(path))])].sort()
    if(!outputFiles.length)throw Error(`Vite build completed without workspace output; environments: ${Object.entries(builder.environments).map(([name,environment])=>`${name}=${JSON.stringify({built:environment.isBuilt,outDir:environment.config.build.outDir,write:environment.config.build.write})}`).join(', ')}; other output: ${Object.keys(readVolume('/dist')).slice(0,15).join(', ')}`)
    return outputFiles
  }finally{await closeBuildConfig?.();browserProcess.env.NODE_ENV=previousNodeEnv}
}
function typecheckNativeProject(){
  const manifestPath='/app/node_modules/typescript/package.json'
  if(!nodeFs.existsSync(manifestPath))throw Error('Project TypeScript dependency is not installed')
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8') as string) as {
    name?:string;version?:string;dependencies?:Record<string,string>
  }
  if(!['typescript','@typescript/typescript6'].includes(manifest.name??'')||!manifest.version)
    throw Error('Invalid project TypeScript package')
  const ts=commonJS.load('/app/node_modules/typescript/lib/typescript.js') as typeof TypeScript
  if(typeof ts.version!=='string'||typeof ts.createProgram!=='function')
    throw Error('Invalid project TypeScript compiler')
  const libDirectory=['/app/node_modules/typescript/lib',
    ...Object.keys(manifest.dependencies??{}).map(name=>`/app/node_modules/${name}/lib`)]
    .find(directory=>nodeFs.existsSync(`${directory}/lib.es2022.d.ts`)&&
      nodeFs.existsSync(`${directory}/lib.es5.d.ts`))
  if(!libDirectory)throw Error('Project TypeScript standard library is not installed')
  const projectFiles=nativeCommandWorker?nodeFs as unknown as Parameters<typeof checkTypeScript>[1]:vol
  return checkTypeScript(ts,projectFiles,'/app/tsconfig.json',libDirectory)
}
let startState:{state:'pending'}|{state:'ready';value:{port:number;webSocketToken:string}}|{state:'failed';error:string}={state:'pending'}
const activeTerminalCommands=new Map<number,AbortController>()
const terminalSessions=new Map<number,NativeTerminalSession>()
let nextTerminalSession=0
let liveInstallInProgress=false
let liveInstallDrain:Promise<void>|undefined
const liveInstallCache=new PackageInstallCache()
let installedManifestText:string|undefined
let installedLockText:string|undefined
let installedPackages:RuntimeLock|undefined
let lastInstallResult:ProjectInstallResult|undefined
function installedPackageManifestsPresent(lock:RuntimeLock){
  return lock.packages.every(pkg=>{
    try{
      const manifest=JSON.parse(String(readFileSync(`${packagePath(pkg.installPath)}/package.json`,'utf8'))) as {version?:string}
      return manifest.version===pkg.version
    }catch{return false}
  })
}
async function installNativeLivePackages(signal:AbortSignal,onProgress:(text:string)=>void){
  if(!server&&!refreshFetchEntry)throw Error('Live dependency installation requires a refreshable project')
  if(liveInstallInProgress)throw Error('A dependency installation is already running')
  if(activeTerminalCommands.size>1)throw Error('Stop other terminal commands before installing dependencies')
  if(!vol.existsSync('/app/package.json'))throw Error('Project package.json is missing')
  liveInstallInProgress=true
  let resolveDrain!:()=>void
  liveInstallDrain=new Promise(resolve=>{resolveDrain=resolve})
  try{
    const manifest=String(readFileSync('/app/package.json','utf8'))
    const lockPath=vol.existsSync('/app/npm-shrinkwrap.json')?'/app/npm-shrinkwrap.json':'/app/package-lock.json'
    const previousLock=vol.existsSync(lockPath)
      ?String(readFileSync(lockPath,'utf8')):undefined
    if(manifest===installedManifestText&&previousLock===installedLockText&&installedPackages&&
      installedPackageManifestsPresent(installedPackages)){
      onProgress('Dependencies are up to date.\n')
      return
    }
    let lockText=previousLock
    let planned:ReturnType<typeof planProjectInstall>|undefined
    if(lockText){
      try{planned=planProjectInstall(manifest,lockText)}
      catch(error){
        if(!(error instanceof Error)||!error.message.startsWith('Lockfile is out of sync with package.json:'))throw error
      }
    }
    if(!planned){
      onProgress('Resolving dependency lock...\n')
      lockText=await resolveProjectLock(manifest,signal,liveInstallCache)
      planned=planProjectInstall(manifest,lockText)
    }
    if(planned.locals.length||planned.links.length)
      throw Object.assign(Error('Native project install does not yet support workspace links'),{code:'ERR_UNSUPPORTED_OPERATION'})
    const installed:RuntimeLock={version:planned.lock.version,packages:planned.lock.packages.map(pkg=>({
      ...packageIdentity(pkg),bundledPackages:pkg.bundledPackages?.map(packageIdentity),
    }))}
    const oldPort=port
    let lastProgress=-1
    try{
      await installLiveLockedPackages(vol,installed,{
        signal,cache:liveInstallCache,expectedManifest:manifest,expectedLock:previousLock,lockPath,
        lockText:lockText===previousLock?undefined:lockText,
        onProgress:state=>{
          if(state.completed!==lastProgress){lastProgress=state.completed;onProgress(`Installed ${state.completed}/${state.total} packages...\n`)}
        },
        afterCommit:async()=>{
          if(!server){await refreshFetchEntry!();return}
          await server!.restart(true)
          await prepareRestartedRunnableEnvironments(server!)
          const optimizer=server!.environments.client.depsOptimizer
          if(optimizer){
            await optimizer.init()
            await optimizer.scanProcessing
            await Promise.all(Object.values(optimizer.metadata.discovered).map(dep=>dep.processing))
          }
          await server!.waitForRequestsIdle()
          const address=server!.httpServer?.address()
          if(!address||typeof address==='string'||address.port!==oldPort)
            throw Error('Vite changed the preview port during dependency installation')
        },
      })
      installedManifestText=manifest
      installedLockText=lockText
      installedPackages=installed
      lastInstallResult=nativeInstallResult(installed,planned.result)
    }catch(error){
      try{if(server){await server.restart(true);await prepareRestartedRunnableEnvironments(server)}}catch(refreshError){
        throw new AggregateError([error,refreshError],'Dependency installation failed and Vite could not restore the prior project')
      }
      throw error
    }
  }finally{
    liveInstallInProgress=false
    liveInstallDrain=undefined
    resolveDrain()
  }
}
if(nestedThread){
  let initialized=false
  let commandIpc:ReturnType<typeof createIpcMessageQueue>|undefined
  let disconnectCommandIpc:(()=>void)|undefined
  let commandStdin:InstanceType<typeof nodeStream.Readable>|undefined
  let commandInputSource:NativeSharedInputSource|undefined
  network.subscribePorts(event=>self.postMessage({type:'native-thread-port',event}))
  self.onmessage=async({data})=>{
    if(data.type==='native-thread-disconnect'){
      if(commandIpc)commandIpc.disconnect(()=>disconnectCommandIpc?.())
      else disconnectCommandIpc?.()
      return
    }
    if(data.type==='native-thread-output-ack'){
      if(typeof data.outputId==='number')stdioTransport.acknowledge(data.outputId)
      return
    }
    if(data.type==='native-thread-connect'){
      void connectWorkerPort(data.port,data.channel)
      return
    }
    if(data.type==='native-thread-message'){
      if(!initialized)throw Error('Native thread received a message before startup')
      if(browserProcess.env.NATIVE_IPC_TRACE==='1')self.postMessage({type:'native-dev-progress',phase:`ipc-child-receive:listeners=${(browserProcess as any).listenerCount?.('message')??0}`})
      try{
        if(nativeCommandWorker){
          if(commandIpc)commandIpc.receive(data.value)
          else (browserProcess as any).emit('message',data.value)
        }
        else nodeWorkerThreads.receiveNativeThreadMessage(data.value)
      }catch(error){if(!isNativeProcessExit(error))throw error}
      return
    }
    if(data.type==='native-thread-file-change'&&nativeCommandWorker){
      if(typeof data.path==='string'&&data.path.startsWith('/app/')&&
        (data.event==='change'||data.event==='rename')){
        nodeFs.receiveNativeFileEvent(data.event,data.path)
        const kind=data.event==='rename'?(nodeFs.existsSync(data.path)?'add':'unlink'):'change'
        if(browserProcess.env.NATIVE_COMMAND_ACTIVITY_TRACE==='1')console.info('FILE_EVENT',kind,data.path)
        for(const server of auxiliaryServers)
          server.watcher.emit(kind,data.path)
      }
      return
    }
    if(data.type==='native-thread-input'&&nativeCommandWorker){
      let acknowledged=false
      const done=()=>{
        if(acknowledged)return
        acknowledged=true
        if(typeof data.inputId==='number')self.postMessage({type:'native-thread-input-ack',inputId:data.inputId})
      }
      if(data.bytes===null||data.bytes instanceof Uint8Array)
        void commandInputSource!.write(data.bytes).then(done,done)
      return
    }
    if(data.type!=='native-thread-start'||initialized)throw Error('Invalid native thread startup message')
    try{
      const threadProgress=(phase:string)=>self.postMessage({type:'native-dev-progress',phase})
      threadProgress('thread-mounting-workspace')
      if(!getNativeFilesystemProvider())resetVolume(data.files as Record<string,Uint8Array>)
      threadProgress('thread-workspace-mounted')
      if(!(data.filePort instanceof MessagePort)||!(data.fileLane instanceof SharedArrayBuffer))
        throw Error('Native thread requires a live file channel')
      if(!(data.portPort instanceof MessagePort)||!(data.portLane instanceof SharedArrayBuffer))
        throw Error('Native thread requires shared virtual port allocation')
      if(!getNativeFilesystemProvider())setNativeSyncFileClient(new NativeSyncFileClient(data.filePort,data.fileLane))
      const commandArgs=Array.isArray(data.argv)?data.argv as string[]:[]
      const typecheckOnly=nativeCommandWorker&&isNativeTypecheck(data.entry,commandArgs,data.evalSource)
      const viteBuild=nativeCommandWorker&&isNativeViteBuild(data.entry,commandArgs,data.evalSource)
      const viteDev=nativeCommandWorker&&isNativeViteDev(data.entry,commandArgs,data.evalSource)
      if(!typecheckOnly){
        const installedPackageRoots=Array.isArray(data.packageRoots)?data.packageRoots as string[]:
          Object.keys(data.files as Record<string,Uint8Array>)
            .filter(path=>path.endsWith('/package.json')&&path.includes('/node_modules/'))
            .map(path=>path.slice(0,-'/package.json'.length))
        threadProgress('thread-lightningcss-initializing')
        await prepareLightningcss(installedPackageRoots)
        threadProgress('thread-oxide-initializing')
        await prepareOxide(installedPackageRoots)
      }
      threadProgress('thread-bindings-ready')
      const portAllocator=new NativeSyncPortClient(data.portPort,data.portLane)
      network.setListenPortAllocator(requested=>portAllocator.allocate(requested))
      const initialCwd=resolveWorkingDirectory('/app',data.cwd??'/app',nodeFs)
      if(!nativeCommandWorker&&!(data.cwdBuffer instanceof SharedArrayBuffer))throw Error('Worker requires shared process directory state')
      initializeProcessDirectory(initialCwd,nativeCommandWorker?undefined:data.cwdBuffer)
      Object.assign(browserProcess.env,data.env??{})
      workerConditions=launchConditions(data.execArgv??[])
      Object.assign(browserProcess,{execArgv:data.execArgv??[]})
      if(nativeCommandWorker){
        const inputLifetime=new NativeInputLifetime(keepNodeCommandAlive)
        commandInputSource=new NativeSharedInputSource(data.inheritedInput?()=>self.postMessage({type:'native-thread-input-demand'}):undefined)
        setProcessInputSource(commandInputSource)
        const reader={},controller=new AbortController(),source=commandInputSource
        commandStdin=new nodeStream.Readable({read(){
          inputLifetime.readRequested()
          void source.read(reader,controller.signal).then(bytes=>{
            if(!controller.signal.aborted)commandStdin!.push(bytes===null?null:nodeBuffer.Buffer.from(bytes))
          }).catch(error=>{if(!controller.signal.aborted)commandStdin!.destroy(error)})
        }})
        commandStdin.once('end',()=>inputLifetime.finish())
        commandStdin.once('close',()=>{controller.abort();inputLifetime.finish()})
        commandStdin.on('pause',()=>inputLifetime.pause())
        const resume=commandStdin.resume.bind(commandStdin)
        commandStdin.resume=()=>{inputLifetime.resume();return resume()}
        Object.assign(browserProcess,{browser:false,platform:'linux',stdin:commandStdin,
          argv:data.stdinSource?[browserProcess.execPath,'-',...(data.argv??[])]:data.evalSource===undefined?[browserProcess.execPath,data.entry,...(data.argv??[])]:[browserProcess.execPath,...(data.argv??[])]})
        const events=new nodeEvents.EventEmitter()
        if(data.fork&&browserProcess.env.NATIVE_IPC_TRACE==='1')events.on('newListener',name=>{
          if(name==='message')threadProgress('ipc-child-listener-attaching')
        })
        if(data.fork)commandIpc=createIpcMessageQueue(events,value=>{
          if(browserProcess.env.NATIVE_IPC_TRACE==='1')threadProgress('ipc-dispatch-start')
          try{events.emit('message',value)}catch(error){if(!isNativeProcessExit(error))throw error}
          finally{if(browserProcess.env.NATIVE_IPC_TRACE==='1')threadProgress('ipc-dispatch-returned')}
        })
        for(const name of ['on','once','off','removeListener','removeAllListeners','emit','listenerCount'] as const)
          Object.assign(browserProcess,{[name]:events[name].bind(events)})
        if(data.fork){
          Object.assign(browserProcess,{connected:true,send:(message:unknown,callback?:Function)=>{
            if(!(browserProcess as any).connected)throw Object.assign(new Error('IPC channel is closed'),{code:'ERR_IPC_CHANNEL_CLOSED'})
            if(browserProcess.env.NATIVE_IPC_TRACE==='1')threadProgress('ipc-child-send')
            self.postMessage({type:'native-thread-message',value:ipcMessage(message,data.ipcSerialization)})
            if(callback)queueMicrotask(()=>callback(null))
            return true
          }})
        }
      }else{
        nodeWorkerThreads.enterNativeThread(data.workerData)
        const processEvents=new nodeEvents.EventEmitter()
        const processWithExit=browserProcess as typeof browserProcess & {
          on:typeof processEvents.on;once:typeof processEvents.once;off:typeof processEvents.off
          removeListener:typeof processEvents.removeListener;emit:typeof processEvents.emit
          exit:(code?:number)=>never;exitCode?:number
        }
        processWithExit.on=processEvents.on.bind(processEvents)
        processWithExit.once=processEvents.once.bind(processEvents)
        processWithExit.off=processEvents.off.bind(processEvents)
        processWithExit.removeListener=processEvents.removeListener.bind(processEvents)
        processWithExit.emit=processEvents.emit.bind(processEvents)
        processWithExit.exit=(code?:number):never=>{
          const status=code??processWithExit.exitCode??0
          if(!Number.isInteger(status))throw TypeError('Process exit code must be an integer')
          try{processEvents.emit('exit',status)}
          catch(error){
            self.postMessage({type:'native-thread-error',error:formatCommandError(error)})
            self.close()
            return undefined as never
          }
          self.postMessage({type:'native-thread-exit',code:status})
          self.close()
          return undefined as never
        }
      }
      if(viteBuild)await ensureCommonJSBridge()
      if(!nativeCommandWorker||data.evalSource===undefined&&!data.stdinSource&&!typecheckOnly&&!viteBuild)
        await ensureThreadEnvironment()
      const runPreloads=async(waitForIdle?:()=>Promise<void>)=>{
        const {preloads,imports=[]}=parseLaunchFlags(data.execArgv??[])
        if(preloads.length)await ensureCommonJSBridge()
        for(const preload of preloads){
          const resolved=commonJS.resolve(preload,nodePath.join(browserProcess.cwd(),'__preload__.cjs'))
          commonJS.load(resolved)
        }
        if(imports.length){
          await ensureThreadEnvironment()
          for(const specifier of imports){
            const requested=specifier.startsWith('file:')?nodeUrl.fileURLToPath(specifier):specifier
            const resolved=resolveVolumeImport(requested,nodePath.join(browserProcess.cwd(),'__preload__.mjs'),'server',workerConditions)
            if(!resolved)throw Error(`Cannot resolve preload ${specifier}`)
            const evaluation=threadModuleLoads.load(resolved,()=>configEnvironment!.runner.import(resolved))
            if(waitForIdle)await awaitModuleEvaluation(evaluation,waitForIdle)
            else await evaluation
          }
        }
      }
      if(!nativeCommandWorker)await runPreloads()
      threadProgress('thread-environment-ready')
      initialized=true
      self.postMessage({type:'native-thread-ready'})
      if(nativeCommandWorker){
        const commandProcess=browserProcess as typeof browserProcess & {
          stdout:{write(value:string):void};stderr:{write(value:string):void};exitCode?:number;
          exit(code?:number):never}
        let finishPromise:Promise<void>|undefined
        const finishCommand=(code:number)=>{
          if(finishPromise)return finishPromise
          finishPromise=(async()=>{
            try{
              await nodeWorkerThreads.disposeNativeWorkers()
              for(const server of auxiliaryServers)await server.close()
              auxiliaryServers.clear()
              disposeOxideWorkers()
              await disposeBrowserRolldown()
            }catch(error){
              commandProcess.stderr.write(`Compiler cleanup failed: ${formatCommandError(error)}\n`)
              code=1
            }
            self.postMessage({type:'native-thread-exit',code})
          })()
          return finishPromise
        }
        commandProcess.exit=(code?:number):never=>{
          const requested=code??commandProcess.exitCode??0
          const status=Number.isInteger(requested)?requested:0
          finishCommand(status)
          throw new NativeProcessExit(status)
        }
        self.addEventListener('unhandledrejection',event=>{
          event.preventDefault()
          if(isNativeProcessExit(event.reason))return
          const reason=event.reason
          commandProcess.stderr.write(`${formatCommandError(reason)}\n`)
          commandProcess.exitCode=1
        })
        const writeStdout=(...args:unknown[])=>commandProcess.stdout.write(nodeUtil.format(...args)+'\n')
        const writeStderr=(...args:unknown[])=>commandProcess.stderr.write(nodeUtil.format(...args)+'\n')
        console.log=writeStdout
        console.info=writeStdout
        console.debug=writeStdout
        console.error=writeStderr
        console.warn=writeStderr
        const activity=beginNodeCommandTimerActivity(browserProcess.env.NATIVE_COMMAND_ACTIVITY_TRACE==='1')
        // A fork IPC channel remains an active handle while the child listens.
        if(data.fork){
          const channel=trackIpcChannelLifetime(browserProcess as any,keepNodeCommandAlive)
          disconnectCommandIpc=()=>{
            if(!(browserProcess as any).connected)return
            Object.assign(browserProcess,{connected:false})
            channel.disconnect()
            self.postMessage({type:'native-thread-disconnect'})
            ;(browserProcess as any).emit('disconnect')
          }
          Object.assign(browserProcess,{disconnect:disconnectCommandIpc})
        }
        commandActivity=activity
        const browserFetch=globalThis.fetch.bind(globalThis)
        globalThis.fetch=((...args:Parameters<typeof fetch>)=>
          trackNodeCommandPromise(browserFetch(...args))) as typeof fetch
        let preloadsComplete=false
        try{
          await runPreloads(activity.waitForIdle)
          preloadsComplete=true
          const entry=resolveWorkerEntry(data.entry,browserProcess.cwd())
          const args=commandArgs
          const importCommandModule=async(id:string)=>{
            // Bootstrap is referenced until evaluation starts. Fetch hooks then
            // account for imports, while guest timers and I/O own their lifetime.
            const release=keepNodeCommandAlive()
            commandEvaluationStarted=release
            try{
              const evaluation=configEnvironment!.runner.import(id).finally(release)
              return await awaitModuleEvaluation(evaluation,activity.waitForIdle)
            }finally{release();commandEvaluationStarted=undefined}
          }
          const evaluateSource=async(source:string,identity:'[stdin]'|'[eval]')=>{
            if(parseLaunchFlags(data.execArgv??[]).inputType==='module'){
              const id=nodePath.join(browserProcess.cwd(),'[eval1]')
              commandSourceModules.set(id,source)
              try{await ensureThreadEnvironment();await importCommandModule(id)}
              catch(error){throw normalizeSourceError(error)}
              finally{commandSourceModules.delete(id)}
            }else commonJS.evaluate(source,resolveWorkerEntry('./'+identity,browserProcess.cwd()),identity)
          }
          // The Vite CLI does not expose its asynchronous action as a promise.
          // Run its build through the same awaited browser builder used by the SDK.
          if(data.stdinSource){
            const chunks:Uint8Array[]=[]
            let length=0
            for await(const chunk of commandStdin!){
              length+=chunk.byteLength
              if(length>1024*1024)throw Error('JavaScript on stdin exceeds 1 MiB')
              chunks.push(chunk)
            }
            const source=new Uint8Array(length)
            let offset=0
            for(const chunk of chunks){source.set(chunk,offset);offset+=chunk.byteLength}
            await evaluateSource(new TextDecoder().decode(source),'[stdin]')
          }else if(data.evalSource!==undefined){
            if(typeof data.evalSource!=='string'||data.evalSource.length>1024*1024)throw Error('Invalid node eval source')
            await evaluateSource(data.evalSource,'[eval]')
          }else if(viteBuild){
            await buildNativeProject(args.includes('--ssr'),'info')
          }else if(viteDev){
            const options=nativeViteDevOptions(entry,args)
            const dev=await createWorkspaceViteServer({logLevel:'info',
              ...(options?.host===undefined?{}:{server:{host:options.host}})})
            await dev.listen()
            dev.printUrls()
            const address=dev.httpServer?.address()
            if(address&&typeof address!=='string')self.postMessage({type:'native-thread-server-ready',port:address.port})
          }else if((entry==='/app/node_modules/typescript/bin/tsc'||
            entry==='/app/node_modules/@typescript/native/bin/tsc')&&args.length===1&&args[0]==='--noEmit'){
            const result=typecheckNativeProject()
            for(const diagnostic of result.diagnostics){
              const location=diagnostic.file?`${diagnostic.file}${diagnostic.line?`(${diagnostic.line},${diagnostic.column})`:''}: `:''
              commandProcess.stderr.write(`${location}error TS${diagnostic.code}: ${diagnostic.message}\n`)
            }
            if(result.diagnostics.some(diagnostic=>diagnostic.category===1))commandProcess.exitCode=2
          }else{
            threadProgress(`command-import-start:${entry}`)
            const commandModule=await importCommandModule(entry) as Record<string,unknown>
            threadProgress(`command-import-complete:${entry}`)
            const completion=commandModule.__promise
            if(completion&&typeof (completion as PromiseLike<unknown>).then==='function'){
              threadProgress('command-completion-pending')
              await completion
              threadProgress('command-completion-ready')
            }
          }
          commandIpc?.finishStartup()
          threadProgress('command-idle-pending')
          await new Promise(resolve=>setTimeout(resolve,0))
          await activity.waitForIdle()
          threadProgress('command-idle-ready')
          await new Promise(resolve=>setTimeout(resolve,0))
          await activity.waitForIdle()
          if(browserProcess.env.NATIVE_COMMAND_ACTIVITY_TRACE==='1')
            commandProcess.stderr.write(`COMMAND_ACTIVITY_TRACE\n${activity.trace().join('\n')}\n`)
          await finishCommand(typeof commandProcess.exitCode==='number'?commandProcess.exitCode:0)
        }catch(error){
          if(error instanceof UnsettledTopLevelAwait){
            if(!preloadsComplete){
              await finishCommand(typeof commandProcess.exitCode==='number'?commandProcess.exitCode:0)
              return
            }
            const requested=typeof commandProcess.exitCode==='number'&&commandProcess.exitCode!==0
            const status=requested?commandProcess.exitCode!:13
            if(!requested)commandProcess.stderr.write(`${error.message}\n`)
            await finishCommand(status)
          }else if(!isNativeProcessExit(error)){
            commandProcess.stderr.write(`${formatCommandError(error)}\n`)
            await finishCommand(1)
          }
        }finally{await finishPromise;commandInputSource?.close();commandActivity=undefined;activity.stop()}
      }else{
        const activity=beginNodeCommandTimerActivity()
        commandActivity=activity
        try{
          if(data.evalSource!==undefined){
            if(typeof data.evalSource!=='string')throw TypeError('Worker eval source must be a string')
            commonJS.evaluate(data.evalSource,resolveWorkerEntry(data.entry,browserProcess.cwd()),'[worker eval]')
          }else await configEnvironment!.runner.import(resolveWorkerEntry(data.entry.startsWith('data:')?new URL(data.entry):data.entry,browserProcess.cwd()))
          await activity.waitForIdle()
          await nodeWorkerThreads.disposeNativeWorkers()
          ;(browserProcess as typeof browserProcess&{exit(code?:number):never}).exit()
        }finally{commandActivity=undefined;activity.stop()}
      }
    }catch(error){
      disposeOxideWorkers()
      let cleanupError:unknown
      try{await disposeBrowserRolldown()}catch(cause){cleanupError=cause}
      self.postMessage({type:'native-thread-error',error:(error instanceof Error?
        `${error.message}\n${error.stack??''}`:String(error))+
        (cleanupError?`\nCompiler cleanup failed: ${String(cleanupError)}`:'')})
    }
  }
  self.postMessage({type:'native-thread-bootstrap-ready'})
}else self.onmessage=async({data})=>{
  const {id,operation}=data
  if(operation==='cancelTerminal'){
    activeTerminalCommands.get(data.commandId)?.abort()
    return
  }
  const operationStarted=performance.now()
  try{
    let value:unknown
    switch(operation){
      case 'start':{
        if(server||configEnvironment)throw Error('Dev server already started')
        nativeRuntimeAssetBaseURL=resolveRuntimeAssetBase(data.assetBaseURL??'/runtime/',self.location.href)
        const restoringForInstall=!!data.restoreSnapshot&&data.installRequested===true
        const startedAt=performance.now()
        const progress=(phase:string)=>self.postMessage({type:'native-dev-progress',phase,elapsedMs:Math.round(performance.now()-startedAt)})
        progress('mounting-workspace')
        const mountedPackageRoots=mountStartWorkspace(data)
        progress('workspace-mounted')
        initializeProcessDirectory('/app')
        if(data.env){
          for(const [name,value] of Object.entries(data.env as Record<string,unknown>)){
            if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)||typeof value!=='string')throw Error(`Invalid project environment variable: ${name}`)
            browserProcess.env[name]=value
          }
        }
        let requestedLock=data.installDependencies===false?undefined:data.lock as RuntimeLock|undefined
        let installPlanResult:ProjectInstallResult|undefined
        let resolvedLockText:string|undefined
        const installCache=new PackageInstallCache()
        let lastActivity=performance.now()
        const installActivity=()=>{
          const now=performance.now()
          if(now-lastActivity>=1000){lastActivity=now;progress('dependencies-active')}
        }
        const startupLockPath=vol.existsSync('/app/npm-shrinkwrap.json')?'/app/npm-shrinkwrap.json':
          vol.existsSync('/app/package-lock.json')?'/app/package-lock.json':undefined
        if(data.installDependencies!==false&&!requestedLock&&startupLockPath){
          if(!vol.existsSync('/app/package.json'))throw Error('Project lockfile requires package.json')
          try{
            const planned=planProjectInstall(readFileSync('/app/package.json','utf8') as string,
              readFileSync(startupLockPath,'utf8') as string)
            if(planned.locals.length||planned.links.length)
              throw Object.assign(Error('Native project install does not yet support workspace links'),{code:'ERR_UNSUPPORTED_OPERATION'})
            requestedLock=planned.lock
            installPlanResult=planned.result
            progress('dependency-lock-planned')
          }catch(error){
            if(!restoringForInstall||!(error instanceof Error)||!error.message.startsWith('Lockfile is out of sync with package.json:'))throw error
            progress('dependency-lock-outdated')
          }
        }
        if(data.installDependencies!==false&&data.installRequested&&!requestedLock){
          if(!vol.existsSync('/app/package.json'))throw Error('Native project install requires package.json')
          progress('dependency-lock-resolving')
          resolvedLockText=await resolveProjectLock(readFileSync('/app/package.json','utf8') as string,
            undefined,installCache,installActivity)
          const planned=planProjectInstall(readFileSync('/app/package.json','utf8') as string,resolvedLockText)
          requestedLock=planned.lock
          installPlanResult=planned.result
          progress('dependency-lock-planned')
        }
        if(requestedLock){
          const lock=requestedLock
          const installed:RuntimeLock={version:lock.version,packages:lock.packages.map(pkg=>({
            ...packageIdentity(pkg),
            bundledPackages:pkg.bundledPackages?.map(packageIdentity),
          }))}
          progress('dependencies-install-started')
          if(restoringForInstall&&vol.existsSync('/app/node_modules'))vol.rmSync('/app/node_modules',{recursive:true,force:true})
          await installLockedPackages(new VolumeFileSystem(vol),installed,
            state=>progress(`dependency-installed:${state.completed}/${state.total}`),undefined,installCache,
            installActivity)
          if(resolvedLockText)vol.writeFileSync(startupLockPath??'/app/package-lock.json',resolvedLockText)
          installedManifestText=vol.existsSync('/app/package.json')?String(readFileSync('/app/package.json','utf8')):undefined
          installedLockText=startupLockPath?String(readFileSync(startupLockPath,'utf8')):
            vol.existsSync('/app/package-lock.json')?String(readFileSync('/app/package-lock.json','utf8')):undefined
          installedPackages=installed
          lastInstallResult=installPlanResult?nativeInstallResult(installed,installPlanResult):undefined
        }
        progress('dependencies-installed')
        const packageRoots=requestedLock
          ?requestedLock.packages.map(pkg=>packagePath(pkg.installPath))
          :mountedPackageRoots
        await prepareLightningcss(packageRoots)
        await prepareOxide(packageRoots)
        progress('native-bindings-ready')
        let entry=data.entry as string|undefined
        if(data.script){
          if(entry)throw Error('Choose either a project script or an entry file')
          const command=readNativeDevScript(readFileSync('/app/package.json','utf8') as string,data.script)
          if(command.kind==='node'){
            const requested=workspacePath(command.entry)
            entry=[requested,`${requested}.js`,`${requested}.mjs`,`${requested}.cjs`].find(path=>vol.existsSync(path))
            if(!entry)throw Error(`Project script entry does not exist: ${command.entry}`)
          }
        }
        const {createServer,createRunnableDevEnvironment,isRunnableDevEnvironment,resolveConfig}=await import('vite')
        progress('vite-module-ready')
        if(entry){
          entry=workspacePath(entry)
          progress('entry-commonjs-lexer-starting')
          await initCommonJSLexer()
          progress('entry-commonjs-lexer-ready')
          Object.defineProperty(globalThis,Symbol.for('web-container:commonjs'),{value:(filename:string)=>commonJS.load(filename),configurable:true})
          const config=await resolveConfig({root:'/app',configFile:false,envDir:false,cacheDir:'/app/.vite',plugins:[volumeResolver(),commonJSPlugin,asyncContextTransform((phase,id,bytes)=>progress(`async-transform-${phase}:${bytes}:${id.slice(-100)}`))],environments:{inline:{consumer:'server',dev:{moduleRunnerTransform:true},resolve:{noExternal:true,conditions:['node','module','import','default']}}}},'serve')
          progress('entry-config-resolved')
          const environment=createRunnableDevEnvironment('inline',config,{runnerOptions:{hmr:false,evaluator:new BrowserModuleEvaluator()},hot:false})
          configEnvironment=environment
          let activeModuleFetches=0,lastModuleFetch=''
          installBrowserModuleFetch(environment,(phase,id)=>{
            traceModuleFetch(phase,id)
            activeModuleFetches+=phase==='start'?1:-1
            if(phase==='start')lastModuleFetch=id
          })
          await environment.init()
          progress('entry-environment-ready')
          const pendingImport=setInterval(()=>progress(`entry-import-pending:${activeModuleFetches}:${lastModuleFetch.slice(-120)}`),5000)
          let loaded
          try{loaded=await environment.runner.import(entry)}
          finally{clearInterval(pendingImport)}
          progress('entry-module-imported')
          const fetchServer=data.serveFetchEntry?await createFetchEntryServer(loaded,{staticRoot:data.staticRoot}):undefined
          if(fetchServer){
            const entryPath=entry
            refreshFetchEntry=async()=>{
              const previous=configEnvironment!
              const next=createRunnableDevEnvironment('inline',config,{runnerOptions:{hmr:false,evaluator:new BrowserModuleEvaluator()},hot:false})
              installBrowserModuleFetch(next,traceModuleFetch)
              try{
                await commonJS.refresh(async()=>{
                  configEnvironment=next
                  await next.init()
                  const replacement=await next.runner.import(entryPath)
                  fetchServer.replace(replacement)
                })
              }catch(error){
                configEnvironment=previous
                try{await next.close()}catch(closeError){throw new AggregateError([error,closeError],'Fetch entry refresh and cleanup failed')}
                throw error
              }
              try{await previous.close()}
              catch(error){self.postMessage({type:'native-dev-diagnostic',error:'Prior fetch environment cleanup failed: '+String(error),stack:error instanceof Error?error.stack:undefined})}
            }
          }
          value={port:fetchServer?.port??0,webSocketToken:''}
          progress('entry-ready')
          break
        }
        let userConfig:Record<string,unknown>={}
        const configPath=['/app/vite.config.ts','/app/vite.config.js','/app/vite.config.mts','/app/vite.config.mjs'].find(path=>vol.existsSync(path))
        if(configPath){
          await initCommonJSLexer()
          Object.defineProperty(globalThis,Symbol.for('web-container:commonjs'),{value:(filename:string)=>commonJS.load(filename),configurable:true})
          const config=await resolveConfig({root:'/app',configFile:false,envDir:false,cacheDir:'/app/.vite',plugins:[...((globalThis as typeof globalThis & {__nativeVite8?:boolean}).__nativeVite8?[volumeResolver()]:[]),commonJSPlugin],environments:{inline:{consumer:'server',dev:{moduleRunnerTransform:true},resolve:{noExternal:true,conditions:['node','module','import','default']}}}},'serve')
          const environment=createRunnableDevEnvironment('inline',config,{runnerOptions:{hmr:false,evaluator:new BrowserModuleEvaluator()},hot:false})
          configEnvironment=environment
          if((globalThis as typeof globalThis & {__nativeVite8?:boolean}).__nativeVite8)installBrowserModuleFetch(environment,traceModuleFetch)
          await environment.init()
          progress('config-runner-ready')
          const loaded=await environment.runner.import(configPath)
          const exported=loaded.default
          userConfig=typeof exported==='function'?await exported({command:'serve',mode:'development',isSsrBuild:false,isPreview:false}):exported
          if(!userConfig||typeof userConfig!=='object')throw Error('Vite config must export an object')
          progress('config-loaded')
        }
        const nativePlugins=(globalThis as typeof globalThis & {__nativeVite8?:boolean}).__nativeVite8?[volumeResolver(),commonJSPlugin,asyncContextTransform()]:[]
        const optimizeDeps=(userConfig as {optimizeDeps?:{rolldownOptions?:{plugins?:unknown[]}}}).optimizeDeps
        const nativeConfig={...userConfig,root:'/app',configFile:false,logLevel:'info',
          optimizeDeps:{...optimizeDeps,rolldownOptions:{...optimizeDeps?.rolldownOptions,
            plugins:[volumeScanPlugin,...(optimizeDeps?.rolldownOptions?.plugins??[])]}},
          // Browser workers have no benefit from speculative module transforms.
          // A pending pre-transform can outlive the request and hold Vite shutdown open.
          server:{preTransformRequests:false,...(userConfig.server as object|undefined)},
          plugins:[...nativePlugins,volumeOptimizerPlugin,...(Array.isArray(userConfig.plugins)?userConfig.plugins:[])]}
        server=await createServer(nativeConfig as Parameters<typeof createServer>[0])
        if(['1','stages','callbacks'].includes(browserProcess.env.NATIVE_VITE_REQUEST_TRACE??'')){
          viteRequestObservation=observeViteRequests(server,row=>self.postMessage({
            type:'native-dev-progress',phase:'vite-request-observation:'+JSON.stringify(row),
          }),{innerStages:['stages','callbacks'].includes(browserProcess.env.NATIVE_VITE_REQUEST_TRACE??''),
            callbackStages:browserProcess.env.NATIVE_VITE_REQUEST_TRACE==='callbacks'})
        }
        progress('vite-server-created')
        if((globalThis as typeof globalThis & {__nativeVite8?:boolean}).__nativeVite8){
          for(const environment of Object.values(server.environments)){
            if(!isRunnableDevEnvironment(environment))continue
            installBrowserModuleFetch(environment,traceModuleFetch)
            environment.runner.evaluator=new BrowserModuleEvaluator()
          }
        }
        progress('vite-runners-installed')
        progress('vite-listen-started')
        await server.listen()
        if(viteRequestObservation)viteRequestObservationTimer=setInterval(()=>viteRequestObservation?.snapshot('interval'),5000)
        server.printUrls()
        progress('vite-listening')
        const address=server.httpServer?.address()
        if(!address||typeof address==='string')throw Error('Vite did not publish a virtual port')
        port=address.port
        value={port,webSocketToken:server.config.webSocketToken}
        break
      }
      case 'startStatus':{
        value=startState
        break
      }
      case 'writeFile':{
        if(!server&&!configEnvironment)throw Error('Project process not started')
        if(liveInstallInProgress)throw Error('Workspace writes are unavailable during dependency installation')
        const path=workspacePath(data.path)
        const kind=nodeFs.existsSync(path)?'change':'add'
        const bytes=typeof data.bytes==='string'?new TextEncoder().encode(data.bytes):data.bytes
        await new VolumeFileSystem(vol).writeFile(path,bytes,{followSymlinks:false})
        server?.watcher.emit(kind,path)
        for(const auxiliary of auxiliaryServers)auxiliary.watcher.emit(kind,path)
        break
      }
      case 'mkdir':{
        if(!server&&!configEnvironment)throw Error('Project process not started')
        if(liveInstallInProgress)throw Error('Workspace writes are unavailable during dependency installation')
        const path=workspacePath(data.path)
        const options=data.options
        if(!options||typeof options!=='object'||Array.isArray(options))throw TypeError('Invalid mkdir options')
        const existed=vol.existsSync(path)
        const files=new NativeTerminalFileSession(vol)
        try{files.call('mkdir',[path,options.recursive??false,options.mode??0o777])}
        finally{files.close()}
        value=!existed
        if(!existed){
          server?.watcher.emit('addDir',path)
          for(const auxiliary of auxiliaryServers)auxiliary.watcher.emit('addDir',path)
        }
        break
      }
      case 'rename':{
        if(!server&&!configEnvironment)throw Error('Project process not started')
        if(liveInstallInProgress)throw Error('Workspace writes are unavailable during dependency installation')
        const from=workspacePath(data.from),to=workspacePath(data.to)
        const directory=vol.lstatSync(from).isDirectory()
        const targetExists=vol.existsSync(to)
        const files=new NativeTerminalFileSession(vol)
        try{files.call('rename',[from,to])}finally{files.close()}
        value=from!==to
        if(from!==to){
          for(const watcher of [server?.watcher,...[...auxiliaryServers].map(auxiliary=>auxiliary.watcher)]){
            watcher?.emit(directory?'unlinkDir':'unlink',from)
            watcher?.emit(directory?'addDir':targetExists?'change':'add',to)
          }
        }
        break
      }
      case 'remove':{
        if(!server&&!configEnvironment)throw Error('Project process not started')
        if(liveInstallInProgress)throw Error('Workspace writes are unavailable during dependency installation')
        const path=workspacePath(data.path),options=data.options
        if(!options||typeof options!=='object'||Array.isArray(options))throw TypeError('Invalid remove options')
        const existed=vol.existsSync(path)
        const directory=existed&&vol.lstatSync(path).isDirectory()
        const files=new NativeTerminalFileSession(vol)
        try{files.call('rm',[path,{recursive:options.recursive??false,force:options.force??false}])}
        finally{files.close()}
        value=existed
        if(existed){
          server?.watcher.emit(directory?'unlinkDir':'unlink',path)
          for(const auxiliary of auxiliaryServers)auxiliary.watcher.emit(directory?'unlinkDir':'unlink',path)
        }
        break
      }
      case 'readFile':{
        if(!server&&!configEnvironment)throw Error('Project process not started')
        value=new Uint8Array(readFileSync(workspacePath(data.path)) as Uint8Array)
        break
      }
      case 'listDirectory':{
        if(!server&&!configEnvironment)throw Error('Project process not started')
        const directory=data.path==='/app'?'/app':workspacePath(data.path)
        value=(vol.readdirSync(directory) as string[]).map(name=>{
          const entry=vol.lstatSync(`${directory.replace(/\/$/,'')}/${name}`)
          return {name,type:entry.isDirectory()?'directory':entry.isSymbolicLink()?'symlink':'file'}
        }).sort((a,b)=>a.name.localeCompare(b.name))
        break
      }
      case 'listTerminalCommands':{
        if(!server&&!configEnvironment)throw Error('Project process not started')
        value=nativeTerminalCommandNames
        break
      }
      case 'terminalCommand':{
        if(!server&&!configEnvironment)throw Error('Project process not started')
        if(liveInstallInProgress)throw Error('Another terminal command is installing dependencies')
        const assetBaseURL=nativeRuntimeAssetBaseURL
        const terminalEnv=Object.fromEntries(Object.entries(browserProcess.env).filter((entry):entry is [string,string]=>typeof entry[1]==='string'))
        const controller=new AbortController()
        activeTerminalCommands.set(id,controller)
        try{
          value=await runNativeTerminalShell(vol,data.line as string,data.cwd as string,assetBaseURL,
            ()=>new Worker(new URL('workers/mvdan-shell.js',assetBaseURL),{type:'module'}),
            (entry,options)=>new nodeWorkerThreads.Worker(entry,{command:true,...options}),
            data.streamOutput===true?(stream,text)=>self.postMessage({type:'native-terminal-output',id,stream,text}):undefined,
            controller.signal,data.inputPort as MessagePort|undefined,data.shellState as string|undefined,
            data.size as {columns:number;rows:number}|undefined,terminalEnv,installNativeLivePackages)
        }finally{activeTerminalCommands.delete(id)}
        break
      }
      case 'terminalSessionOpen':{
        if(!server&&!configEnvironment)throw Error('Project process not started')
        if(terminalSessions.size>=8)throw Error('Terminal session limit exceeded')
        const assetBaseURL=nativeRuntimeAssetBaseURL
        const terminalEnv=Object.fromEntries(Object.entries(browserProcess.env).filter((entry):entry is [string,string]=>typeof entry[1]==='string'))
        const session=new NativeTerminalSession(vol,data.cwd as string,assetBaseURL,
          ()=>new Worker(new URL('workers/mvdan-shell.js',assetBaseURL),{type:'module'}),
          (entry,options)=>new nodeWorkerThreads.Worker(entry,{command:true,...options}),
          installNativeLivePackages,terminalEnv)
        try{await session.ready}catch(error){session.dispose();throw error}
        value=++nextTerminalSession
        terminalSessions.set(value as number,session)
        break
      }
      case 'terminalSessionRun':{
        const session=terminalSessions.get(data.sessionId)
        if(!session)throw Error('Terminal session closed')
        if(liveInstallInProgress)throw Error('Another terminal command is installing dependencies')
        const controller=new AbortController()
        activeTerminalCommands.set(id,controller)
        try{
          value=await session.run(data.line as string,data.streamOutput===true
            ?(stream,text)=>self.postMessage({type:'native-terminal-output',id,stream,text}):undefined,
            controller.signal,data.inputPort as MessagePort|undefined,data.size as {columns:number;rows:number}|undefined)
        }finally{
          if(controller.signal.aborted)await liveInstallDrain
          activeTerminalCommands.delete(id)
        }
        break
      }
      case 'terminalSessionClose':{
        const session=terminalSessions.get(data.sessionId)
        if(session){terminalSessions.delete(data.sessionId);session.dispose()}
        break
      }
      case 'snapshot':{
        if(!server&&!configEnvironment)throw Error('Project process not started')
        value=readVolume('/app')
        break
      }
      case 'snapshotWorkspace':{
        if(!server&&!configEnvironment)throw Error('Project process not started')
        value=snapshotVolume('/app')
        break
      }
      case 'installResult':{
        if(!lastInstallResult)throw Error('No committed dependency install result is available')
        value=structuredClone(lastInstallResult)
        break
      }
      case 'typecheck':{
        if(!server&&!configEnvironment)throw Error('Project process not started')
        value=typecheckNativeProject()
        break
      }
      case 'build':{
        if(!server&&!configEnvironment)throw Error('Project process not started')
        value=await buildNativeProject(data.ssr===true)
        break
      }
      case 'connect':{
        if(!server&&!configEnvironment||!virtualListeningPorts().includes(data.port))throw Error('Port is not owned by this project process')
        while(sockets.size+pendingConnections>=maxConnections){
          await new Promise<void>(resolve=>connectionWaiters.add(resolve))
          if(!server&&!configEnvironment)throw Error('Project process closed')
        }
        pendingConnections++
        try{
          const socket=await connectVirtual(data.port)
          const socketId=++nextSocket
          sockets.set(socketId,socket)
          value={socketId,port:socket.port,remotePort:socket.remotePort}
        }finally{pendingConnections--;wakeConnectionWaiter()}
        break
      }
      case 'ports':{
        if(!server&&!configEnvironment)throw Error('Project process not started')
        value=virtualListeningPorts()
        break
      }
      case 'read':{
        const socket=sockets.get(data.socketId)
        if(!socket)throw Error('Preview connection closed')
        value=await socket.read()
        break
      }
      case 'write':{
        const socket=sockets.get(data.socketId)
        if(!socket)throw Error('Preview connection closed')
        await socket.write(data.bytes)
        break
      }
      case 'end':{
        const socket=sockets.get(data.socketId)
        if(!socket)throw Error('Preview connection closed')
        await socket.end()
        break
      }
      case 'closeSocket':{
        const socket=sockets.get(data.socketId)
        if(socket){sockets.delete(data.socketId);wakeConnectionWaiter();await socket.close()}
        break
      }
      case 'close':{
        viteRequestObservation?.snapshot('before worker close')
        clearInterval(viteRequestObservationTimer)
        viteRequestObservationTimer=undefined
        viteRequestObservation?.dispose()
        viteRequestObservation=undefined
        for(const session of terminalSessions.values())session.dispose()
        terminalSessions.clear()
        for(const wake of connectionWaiters)wake()
        connectionWaiters.clear()
        const cleanupErrors:unknown[]=[]
        const cleanup=async(close:()=>Promise<unknown>)=>{
          try{await close()}
          catch(error){
            if((error as {code?:string}).code!=='ECONNRESET'&&!String(error).includes('ECONNRESET'))cleanupErrors.push(error)
          }
        }
        for(const socket of sockets.values())await cleanup(()=>socket.close())
        sockets.clear()
        if(server)await cleanup(()=>server!.close())
        for(const auxiliary of auxiliaryServers)await cleanup(()=>auxiliary.close())
        auxiliaryServers.clear()
        if(configEnvironment)await cleanup(()=>configEnvironment!.close())
        configEnvironment=undefined
        refreshFetchEntry=undefined
        server=undefined
        port=undefined
        await cleanup(async()=>{disposeOxideWorkers()})
        await cleanup(nodeWorkerThreads.disposeNativeWorkers)
        await cleanup(disposeBrowserRolldown)
        if(cleanupErrors.length)throw new AggregateError(cleanupErrors,'Native dev server cleanup failed')
        break
      }
      default:throw Error('Unknown dev server operation')
    }
    if(operation==='start'){
      startState={state:'ready',value:value as {port:number;webSocketToken:string}}
      self.postMessage({type:'native-dev-progress',phase:'start-response-ready',elapsedMs:Math.round(performance.now()-operationStarted)})
    }
    self.postMessage({id,ok:true,value})
    if(operation==='start')self.postMessage({type:'native-dev-progress',phase:'start-response-posted',elapsedMs:Math.round(performance.now()-operationStarted)})
  }catch(error){
    if(operation==='start')startState={state:'failed',error:error instanceof Error?error.stack??error.message:String(error)}
    if(operation==='start'){await configEnvironment?.close();configEnvironment=undefined}
    self.postMessage({id,ok:false,error:error instanceof Error?`${error.name}: ${error.message}`:String(error),
      stack:error instanceof Error?error.stack:undefined})
  }
}
if(!nestedThread)self.postMessage({type:'native-dev-ready'})
