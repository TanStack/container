import {NativeDevServer} from './dev-server'
import type {NativeDevServerEvent,NativeDevServerOptions} from './dev-server'
import type {CheckpointMetadata} from '../sandbox/checkpoint-storage'
import type {WorkspaceSnapshot} from '../sandbox/files'
import type {WorkerWebSocket} from '../sandbox/worker-websocket'
import {IncomingRequest} from '../sandbox/incoming-request'
import {parseNativeInstallCommand} from './project-script'
import type {NativeRuntimeCandidate} from './runtime-selection'
import {prepareNativeRuntime} from './prepare-runtime'
import {mountNativeWorkspaceFiles} from './workspace-mount'
import {resolveRuntimeAssetBase} from '../sandbox/runtime-assets'
import {nativeOwnerBuildId,verifyNativeOwnerBuildId} from './owner-build-identity'
import type {NativeTerminalOutput} from './terminal-types'
import type {ProjectInstallResult} from '../npm/project'
import type {NativeOwnerResourceSnapshot} from './owner-resources'
import {NativeTerminalCapture} from './terminal-capture'
import {NativeTerminalInputSender} from './terminal-input-sender'
import {abortableWait} from '../sandbox/abortable-wait'

type OwnerOptions=Omit<NativeDevServerOptions,'workerURL'|'runtimeCandidates'|'assetBaseURL'> & {previewPort?:number}
type Pending={resolve:(value:any)=>void;reject:(error:Error)=>void;timer?:ReturnType<typeof setTimeout>;timeoutMs?:number;operation?:string;onOutput?:NativeTerminalOutput;cleanup?:()=>void}
const protocol='native-owner-v1'
const ownerChannelProtocol=protocol

/** Install this only in a dedicated owner-origin frame, never in the app host. */
export function installNativeOwnerHost(options:{allowedParentOrigin:string;workerURL:string|URL;assetBaseURL?:string;runtimeCandidates?:readonly NativeRuntimeCandidate[];previewOrigin?:string;previewHostSuffix?:string;buildId?:string;maxTerminalOutputBytes?:number}){
  const maxTerminalOutputBytes=new NativeTerminalCapture(options.maxTerminalOutputBytes).maxBytes
  const buildId=nativeOwnerBuildId(options.buildId)
  const parentOrigin=new URL(options.allowedParentOrigin).origin
  if(parentOrigin!==options.allowedParentOrigin)throw Error('Expected an exact parent origin')
  const workerURL=new URL(options.workerURL,location.href)
  if(workerURL.origin!==location.origin)throw Error('Owner worker must be served on the owner origin')
  const assetBaseURL=resolveRuntimeAssetBase(options.assetBaseURL??'/runtime/',location.href)
  const runtimeCandidates=options.runtimeCandidates?.map(candidate=>{
    const url=new URL(candidate.workerURL,location.href)
    if(url.origin!==location.origin||!['http:','https:'].includes(url.protocol))throw Error('Owner runtime candidate must be served on the owner origin')
    return {workerURL:url.href,toolchain:{...candidate.toolchain}}
  })
  const configuredPreview=options.previewOrigin?new URL(options.previewOrigin):undefined
  if(configuredPreview&&configuredPreview.origin!==options.previewOrigin)throw Error('Expected an exact preview origin')
  if(options.previewHostSuffix&&(!configuredPreview||!/^\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(options.previewHostSuffix)))
    throw Error('Preview host suffix requires an exact base preview origin')
  let previewOrigin=options.previewOrigin
  let accepted=false
  let server:NativeDevServer|undefined
  let startupController:AbortController|undefined
  let restartOptions:NativeDevServerOptions|undefined
  let requestedPreviewPort:number|undefined
  let selectedPort=0
  let unsubscribe:(()=>void)|undefined
  let port:MessagePort|undefined
  const streams=new Set<{port:MessagePort;reader:ReadableStreamDefaultReader<Uint8Array>}>()
  const httpRequests=new Set<()=>void>()
  const sockets=new Set<{port:MessagePort;socket:WorkerWebSocket}>()
  const terminalControllers=new Map<number,AbortController>()
  const terminalSessions=new Map<number,Awaited<ReturnType<NativeDevServer['openTerminalSession']>>>()
  let nextTerminalSession=0
  const activeMutations=new Set<Promise<void>>()
  let installGate:Promise<void>|undefined
  const disconnect=()=>{
    for(const cancel of httpRequests)cancel()
    for(const controller of terminalControllers.values())controller.abort()
    terminalControllers.clear()
    for(const session of terminalSessions.values())void session.dispose().catch(()=>{})
    terminalSessions.clear()
    unsubscribe?.();unsubscribe=undefined
    for(const stream of streams){
      stream.port.close()
      void stream.reader.cancel().catch(()=>{})
    }
    streams.clear()
    for(const item of sockets){item.port.close();void item.socket.dispose()}
    sockets.clear()
  }
  const dispose=async()=>{
    startupController?.abort(Error('Owner startup cancelled'))
    startupController=undefined
    disconnect()
    const current=server;server=undefined;selectedPort=0
    restartOptions=undefined;requestedPreviewPort=undefined
    if(current)await current.dispose()
  }
  const onConnect=(event:MessageEvent)=>{
    if(event.origin!==parentOrigin||event.source!==parent||event.data?.protocol!==protocol||
      event.data?.type!=='connect'||event.ports.length!==1||accepted)return
    try{verifyNativeOwnerBuildId(buildId,event.data.expectedBuildId)}catch(error){
      event.ports[0]!.postMessage({protocol,type:'connect-error',error:String(error)})
      event.ports[0]!.close()
      return
    }
    const requested=event.data.previewOrigin
    if(requested!==undefined){
      let candidate:URL|undefined
      try{candidate=new URL(requested)}catch{/* Reject below. */}
      const allowed=candidate&&candidate.origin===requested&&configuredPreview&&
        (requested===options.previewOrigin||Boolean(options.previewHostSuffix&&
          candidate.protocol===configuredPreview.protocol&&candidate.port===configuredPreview.port&&
          candidate.hostname.endsWith(options.previewHostSuffix)&&
          candidate.hostname.length>options.previewHostSuffix.length))
      if(!allowed){
        event.ports[0]!.postMessage({protocol,type:'connect-error',error:'Preview origin is not allowed'})
        event.ports[0]!.close()
        return
      }
      previewOrigin=requested
    }
    accepted=true
    port=event.ports[0]!
    port.onmessage=async({data,ports})=>{
      if(data?.protocol===protocol&&data.type==='terminal-cancel'&&Number.isSafeInteger(data.id)){
        terminalControllers.get(data.id)?.abort()
        return
      }
      if(data?.protocol!==protocol||data.type!=='request'||!Number.isSafeInteger(data.id)||
        typeof data.operation!=='string')return
      port?.postMessage({protocol,type:'accepted',id:data.id})
      const installLine=data.operation==='terminalCommand'&&typeof data.line==='string'&&
        data.cwd===(restartOptions?.workspaceRoot??'/app')?data.line.trim():undefined
      let terminalInstall=false
      if(installLine){try{parseNativeInstallCommand(installLine);terminalInstall=true}catch{/* Other shell syntax uses the regular terminal. */}}
      const installing=data.operation==='reinstall'||data.operation==='restoreWorkspace'||terminalInstall
      const mutating=['writeFile','mkdir','rename','remove','terminalCommand','terminalSessionOpen','terminalSessionRun','build','runBuildScript','restart'].includes(data.operation)&&!installing
      const installController=terminalInstall?new AbortController():undefined
      if(installController)terminalControllers.set(data.id,installController)
      let releaseInstall:(()=>void)|undefined
      let releaseMutation:(()=>void)|undefined
      let ownsStartup:AbortController|undefined
      try{
        if(installing){
          if(installGate)throw Error('An install is already running')
          installGate=new Promise(resolve=>{releaseInstall=resolve})
          await Promise.all(activeMutations)
        }else if(mutating){
          if(installGate)await installGate
          const active=new Promise<void>(resolve=>{releaseMutation=resolve})
          activeMutations.add(active)
          active.finally(()=>activeMutations.delete(active))
        }
        port?.postMessage({protocol,type:'started',id:data.id})
        let value:unknown
        switch(data.operation){
          case 'start':{
            if(server||startupController)throw Error('Owner already has a running or starting project')
            ownsStartup=startupController=new AbortController()
            const {previewPort,...serverOptions}=data.options as OwnerOptions
            const options={...serverOptions,workerURL,runtimeCandidates,assetBaseURL}
            let files=data.files as Record<string,string|Uint8Array>
            if(runtimeCandidates&&options.installDependencies!==false){
              const root=options.workspaceRoot??'/app'
              const prepared=await prepareNativeRuntime(mountNativeWorkspaceFiles(files,root),runtimeCandidates,
                {lock:options.lock,signal:ownsStartup.signal})
              ownsStartup.signal.throwIfAborted()
              files=Object.fromEntries(Object.entries(prepared.files).map(([path,value])=>[root+path.slice('/app'.length),value]))
              options.lock=prepared.lock
            }
            server=new NativeDevServer(files,options)
            restartOptions=options;requestedPreviewPort=previewPort
            unsubscribe=server.subscribeEvents(event=>port?.postMessage({protocol,type:'event',event}))
            value=await server.waitForHTTPReady({port:previewPort})
            ownsStartup.signal.throwIfAborted()
            selectedPort=value as number
            break
          }
          case 'restore':{
            if(server||startupController)throw Error('Owner already has a running or starting project')
            ownsStartup=startupController=new AbortController()
            const {previewPort,...serverOptions}=data.options as OwnerOptions
            const options={...serverOptions,workerURL,runtimeCandidates,assetBaseURL}
            const restoreStarted=performance.now()
            const progress=(phase:string)=>port?.postMessage({protocol,type:'event',event:{
              type:'progress',phase,elapsedMs:Math.round(performance.now()-restoreStarted),
            } satisfies NativeDevServerEvent})
            progress('restore-checkpoint-loading')
            const restored=await NativeDevServer.restoreCheckpoint(data.key as string,
              options)
            if(ownsStartup.signal.aborted){
              await restored.dispose()
              ownsStartup.signal.throwIfAborted()
            }
            server=restored
            restartOptions=options;requestedPreviewPort=previewPort
            progress('restore-worker-created')
            unsubscribe=server.subscribeEvents(event=>port?.postMessage({protocol,type:'event',event}))
            value=await server.waitForHTTPReady({port:previewPort})
            ownsStartup.signal.throwIfAborted()
            progress('restore-http-ready')
            selectedPort=value as number
            break
          }
          case 'restart':{
            const current=requireServer()
            if(!restartOptions)throw Error('Owner restart options are unavailable')
            disconnect()
            server=undefined;selectedPort=0
            server=await current.restart(restartOptions)
            unsubscribe=server.subscribeEvents(event=>port?.postMessage({protocol,type:'event',event}))
            value=await server.waitForHTTPReady({port:requestedPreviewPort})
            selectedPort=value as number
            break
          }
          case 'reinstall':{
            const current=requireServer()
            if(!restartOptions)throw Error('Owner install options are unavailable')
            const replacement=await current.reinstall(restartOptions,undefined,undefined,
              candidate=>candidate.waitForHTTPReady({port:requestedPreviewPort}).then(()=>{}))
            disconnect()
            server=replacement
            unsubscribe=server.subscribeEvents(event=>port?.postMessage({protocol,type:'event',event}))
            value=await server.waitForHTTPReady({port:requestedPreviewPort})
            selectedPort=value as number
            break
          }
          case 'writeFile':value=await requireServer().writeFile(data.path as string,data.bytes as string|Uint8Array);break
          case 'installResult':value=await requireServer().installResult();break
          case 'restoreWorkspace':{
            if(!restartOptions)throw Error('Owner restore options are unavailable')
            const replacement=await requireServer().restoreWorkspace(data.snapshot as Extract<WorkspaceSnapshot,{version:5}>,restartOptions,
              candidate=>candidate.waitForHTTPReady({port:requestedPreviewPort}).then(()=>{}))
            disconnect()
            server=replacement
            unsubscribe=server.subscribeEvents(event=>port?.postMessage({protocol,type:'event',event}))
            value=await server.waitForHTTPReady({port:requestedPreviewPort})
            selectedPort=value as number
            break
          }
          case 'readFile':value=await requireServer().readFile(data.path as string);break
          case 'mkdir':value=await requireServer().mkdir(data.path as string,data.options as {recursive?:boolean;mode?:number});break
          case 'rename':value=await requireServer().rename(data.from as string,data.to as string);break
          case 'remove':value=await requireServer().remove(data.path as string,data.options as {recursive?:boolean;force?:boolean});break
          case 'listDirectory':value=await requireServer().listDirectory(data.path as string);break
          case 'listTerminalCommands':value=await requireServer().listTerminalCommands();break
          case 'terminalCommand':{
            const controller=installController??new AbortController()
            const inputPort=ports[0]
            if(!installController)terminalControllers.set(data.id,controller)
            try{
              const capture=new NativeTerminalCapture(maxTerminalOutputBytes)
              const output=(text:string,stream:'stdout'|'stderr'='stdout')=>{
                capture.write(text,stream)
                port?.postMessage({protocol,type:'terminal-output',id:data.id,text,stream})
              }
              if(terminalInstall){
                if(!restartOptions)throw Error('Owner install options are unavailable')
                output('Installing dependencies...\n')
                let lastProgressPercent=-10
                try{
                  const replacement=await requireServer().reinstall(restartOptions,event=>{
                    port?.postMessage({protocol,type:'event',event})
                    if(event.type==='progress'){
                      const count=/^dependency-installed:(\d+)\/(\d+)$/.exec(event.phase)
                      const percent=count&&Number(count[2])>0?Math.floor(Number(count[1])*100/Number(count[2])):0
                      if(count&&(percent>=lastProgressPercent+10||Number(count[1])===Number(count[2]))){
                        lastProgressPercent=percent
                        output(`Installed ${count[1]}/${count[2]} packages...\n`)
                      }
                    }
                  },controller.signal,candidate=>candidate.waitForHTTPReady({port:requestedPreviewPort}).then(()=>{}))
                  terminalControllers.delete(data.id)
                  disconnect()
                  server=replacement
                  unsubscribe=server.subscribeEvents(event=>port?.postMessage({protocol,type:'event',event}))
                  selectedPort=await server.waitForHTTPReady({port:requestedPreviewPort})
                  output('Dependencies ready\n')
                  value={cwd:data.cwd,...capture.finish(),exitCode:0,changedPaths:[`${data.cwd}/package-lock.json`]}
                }catch(error){
                  if(controller.signal.aborted){output('Install interrupted\n','stderr');value={cwd:data.cwd,...capture.finish(),exitCode:130,changedPaths:[]}}
                  else{output(`Install failed: ${String(error)}\n`,'stderr');value={cwd:data.cwd,...capture.finish(),exitCode:1,changedPaths:[]}}
                }
              }else{
                const result=await requireServer().terminalCommand(data.line as string,data.cwd as string,
                  output,controller.signal,inputPort,data.shellState as string|undefined,
                  data.size as {columns:number;rows:number}|undefined)
                value={...result,...capture.finish()}
              }
            }finally{terminalControllers.delete(data.id);inputPort?.close()}
            break
          }
          case 'terminalSessionOpen':{
            if(terminalSessions.size>=8)throw Error('Terminal session limit exceeded')
            const session=await requireServer().openTerminalSession(data.cwd as string)
            value=++nextTerminalSession
            terminalSessions.set(value as number,session)
            break
          }
          case 'terminalSessionRun':{
            const session=terminalSessions.get(data.sessionId)
            if(!session)throw Error('Terminal session closed')
            const controller=new AbortController()
            const inputPort=ports[0]
            terminalControllers.set(data.id,controller)
            try{
              const capture=new NativeTerminalCapture(maxTerminalOutputBytes)
              const output=(text:string,stream:'stdout'|'stderr'='stdout')=>{
                capture.write(text,stream)
                port?.postMessage({protocol,type:'terminal-output',id:data.id,text,stream})
              }
              const result=await session.runCommand(data.line as string,output,controller.signal,inputPort,
                data.size as {columns:number;rows:number}|undefined)
              value={...result,...capture.finish()}
            }finally{terminalControllers.delete(data.id);inputPort?.close()}
            break
          }
          case 'terminalSessionClose':{
            const session=terminalSessions.get(data.sessionId)
            if(session){terminalSessions.delete(data.sessionId);await session.dispose()}
            break
          }
          case 'saveCheckpoint':value=await requireServer().saveCheckpoint(data.key as string);break
          case 'snapshotWorkspace':value=await requireServer().snapshotWorkspace();break
          case 'build':value=await requireServer().build(data.options as {ssr?:boolean});break
          case 'typecheck':value=await requireServer().typecheck();break
          case 'runBuildScript':value=await requireServer().runBuildScript(data.name as string);break
          case 'ports':value=await requireServer().ports();break
          case 'workspaceRevision':value=requireServer().workspaceRevision();break
          case 'hmrURL':value=await requireServer().hmrURL();break
          case 'websocket-connect':{
            const socketPort=ports[0]
            if(!socketPort||!previewOrigin)throw Error('Owner preview WebSockets are not configured')
            if(data.origin!==previewOrigin)throw Error('Unexpected owner preview origin')
            if(sockets.size>=32)throw Error('Owner WebSocket limit reached')
            const socketURL=new URL(data.url as string)
            const previewURL=new URL(previewOrigin)
            const previewAddress=socketURL.host===previewURL.host&&
              socketURL.protocol===(previewURL.protocol==='https:'?'wss:':'ws:')
            const socket=previewAddress
              ?await requireServer().previewWebSocket(selectedPort,previewOrigin,
                socketURL.href,data.protocols as string[])
              :await requireServer().connectWebSocket(previewOrigin,
                socketURL.href,data.protocols as string[])
            const item={port:socketPort,socket}
            sockets.add(item)
            socketPort.onmessage=async({data:command})=>{
              if(command?.protocol!==protocol||command.type!=='request'||!Number.isSafeInteger(command.id))return
              try{
                let result:unknown
                switch(command.operation){
                  case 'send':result=await socket.send(command.data as string|Uint8Array);break
                  case 'next':result=await socket.next();break
                  case 'close':result=await socket.close(command.code as number,command.reason as string);break
                  case 'dispose':{
                    result=await socket.dispose()
                    sockets.delete(item)
                    break
                  }
                  default:throw Error('Unsupported owner WebSocket operation')
                }
                socketPort.postMessage({protocol,type:'response',id:command.id,ok:true,value:result})
                if(command.operation==='dispose')socketPort.close()
              }catch(error){
                socketPort.postMessage({protocol,type:'response',id:command.id,ok:false,error:String(error)})
              }
            }
            socketPort.start()
            value={protocol:socket.protocol}
            break
          }
          case 'fetch':{
            const bodyPort=ports[0]
            if(!bodyPort)throw Error('HTTP response channel is required')
            const controller=new AbortController()
            let stream:{port:MessagePort;reader:ReadableStreamDefaultReader<Uint8Array>}|undefined
            let finished=false
            const finish=()=>{
              if(finished)return
              finished=true
              httpRequests.delete(cancel)
              if(stream)streams.delete(stream)
              bodyPort.close()
            }
            const cancel=()=>{
              if(finished)return
              controller.abort(Error('Owner HTTP request cancelled'))
              bodyPort.postMessage({type:'error',error:String(controller.signal.reason)})
              if(stream)void stream.reader.cancel(controller.signal.reason).catch(()=>{})
              finish()
            }
            httpRequests.add(cancel)
            // Listen before waiting for headers, cancellation can arrive while
            // a document's module requests are still occupying HTTP slots.
            bodyPort.onmessage=({data:message})=>{if(message?.type==='cancel')cancel()}
            bodyPort.start()
            let response:Response
            try{
              const request=new IncomingRequest(data.url as string,{
                method:data.method as string,headers:data.headers as [string,string][],signal:controller.signal,
                ...(data.body?{body:Uint8Array.from(data.body as Uint8Array).buffer}:{}),
              })
              const pending=previewOrigin&&new URL(request.url).origin===previewOrigin
                ?requireServer().previewServer(selectedPort).fetch(request)
                :requireServer().fetch(request)
              // A source which ignores cancellation must not retain a late body.
              void pending.then(response=>{
                if(controller.signal.aborted)void response.body?.cancel().catch(()=>{})
              }).catch(()=>{})
              response=await abortableWait(pending,controller.signal)
            }catch(error){cancel();throw error}
            const reader=response.body?.getReader()
            if(reader){
              stream={port:bodyPort,reader}
              streams.add(stream)
              bodyPort.onmessage=async({data:message})=>{
                if(message?.type==='cancel'){cancel();return}
                if(message?.type!=='pull'||finished)return
                try{
                  const next=await abortableWait(reader.read(),controller.signal)
                  if(finished)return
                  if(next.done){
                    bodyPort.postMessage({type:'done'})
                    finish()
                  }else{
                    const bytes=new Uint8Array(next.value)
                    bodyPort.postMessage({type:'chunk',bytes},[bytes.buffer])
                  }
                }catch(error){
                  if(finished)return
                  bodyPort.postMessage({type:'error',error:String(error)})
                  cancel()
                }
              }
            }else finish()
            value={status:response.status,statusText:response.statusText,
              headers:[...response.headers],hasBody:Boolean(reader)}
            break
          }
          case 'dispose':await dispose();value=undefined;break
          case 'resources':value={scope:'native-owner',running:Boolean(server),starting:Boolean(startupController),
            commands:terminalControllers.size,terminalSessions:terminalSessions.size,
            responseStreams:streams.size,sockets:sockets.size,mutations:activeMutations.size,
            installing:Boolean(installGate)} satisfies NativeOwnerResourceSnapshot;break
          default:throw Error(`Unsupported owner operation: ${data.operation}`)
        }
        port?.postMessage({protocol,type:'response',id:data.id,ok:true,value})
      }catch(error){
        if((ownsStartup&&startupController===ownsStartup)||data.operation==='restart')await dispose().catch(()=>{})
        port?.postMessage({protocol,type:'response',id:data.id,ok:false,error:String(error)})
      }finally{
        if(ownsStartup&&startupController===ownsStartup)startupController=undefined
        if(installController)terminalControllers.delete(data.id)
        releaseMutation?.()
        if(releaseInstall){releaseInstall();installGate=undefined}
      }
    }
    port.start()
    port.postMessage({protocol,type:'connected',buildId})
  }
  const requireServer=()=>{
    if(!server)throw Error('Owner project is not running')
    return server
  }
  addEventListener('message',onConnect)
  return async()=>{
    removeEventListener('message',onConnect)
    port?.close();port=undefined
    await dispose()
  }
}

/** Host-side control channel. The project worker and checkpoint store stay on the owner origin. */
export class NativeOwnerClient{
  readonly events:NativeDevServerEvent[]=[]
  #port:MessagePort
  #pending=new Map<number,Pending>()
  #listeners=new Set<(event:NativeDevServerEvent)=>void>()
  #httpRequests=new Set<(reason:unknown)=>void>()
  #next=0
  #closed=false
  #connectedAt=performance.now()
  private constructor(port:MessagePort){
    this.#port=port
    port.onmessage=({data})=>{
      if(data?.protocol!==protocol)return
      if(data.type==='event'){
        const incoming=data.event as NativeDevServerEvent
        // Restore and replacement servers have their own clock origins. Keep
        // this client's complete event history on one receiving clock instead.
        const event=incoming.type==='progress'
          ?{...incoming,elapsedMs:Math.round(performance.now()-this.#connectedAt)}
          :incoming
        this.events.push(event)
        if(this.events.length>256)this.events.shift()
        for(const listener of this.#listeners)try{listener(event)}catch{/* Observers cannot affect the owner. */}
        return
      }
      if(data.type==='terminal-output'){
        try{this.#pending.get(data.id)?.onOutput?.(data.text as string,data.stream)}
        catch{/* Terminal observers cannot affect the owner. */}
        return
      }
      if(data.type==='accepted'||data.type==='started'){
        const pending=this.#pending.get(data.id)
        if(!pending||pending.timeoutMs===undefined||pending.timeoutMs===0)return
        clearTimeout(pending.timer)
        const waiting=data.type==='accepted'
        pending.timer=setTimeout(()=>{
          this.#pending.delete(data.id)
          pending.cleanup?.()
          pending.reject(Error(`Owner ${pending.operation} ${waiting?'waited too long in the command queue':'timed out'}`))
        },waiting?300000:pending.timeoutMs)
        return
      }
      if(data.type!=='response')return
      const pending=this.#pending.get(data.id)
      if(!pending)return
      this.#pending.delete(data.id)
      clearTimeout(pending.timer)
      pending.cleanup?.()
      data.ok?pending.resolve(data.value):pending.reject(Error(data.error))
    }
    port.start()
  }
  static async connect(frame:Window,ownerOrigin:string,previewOrigin?:string,options:{expectedBuildId?:string}={}){
    const expectedBuildId=nativeOwnerBuildId(options.expectedBuildId)
    const origin=new URL(ownerOrigin).origin
    if(origin!==ownerOrigin||origin===location.origin)throw Error('Expected an exact separate owner origin')
    const channel=new MessageChannel()
    const connected=new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Owner frame did not connect')),10000)
      channel.port1.onmessage=({data})=>{
        if(data?.protocol!==protocol)return
        if(data.type==='connect-error'){clearTimeout(timer);reject(Error(data.error));return}
        if(data.type==='connected'){
          clearTimeout(timer)
          try{verifyNativeOwnerBuildId(data.buildId,expectedBuildId);resolve()}catch(error){reject(error)}
        }
      }
      channel.port1.start()
    })
    frame.postMessage({protocol,type:'connect',previewOrigin,expectedBuildId},origin,[channel.port2])
    try{await connected;return new NativeOwnerClient(channel.port1)}
    catch(error){channel.port1.close();throw error}
  }
  #call<T>(operation:string,fields:Record<string,unknown>={},timeoutMs=120000,transfer:Transferable[]=[],onOutput?:NativeTerminalOutput,signal?:AbortSignal,cancelOperation?:()=>void):Promise<T>{
    if(this.#closed)return Promise.reject(Error('Owner channel closed'))
    if(signal?.aborted)return Promise.reject(cancelOperation?signal.reason:Object.assign(Error('Terminal command interrupted'),{name:'AbortError'}))
    return new Promise((resolve,reject)=>{
      const id=++this.#next
      const abort=()=>{
        if(!cancelOperation){this.#port.postMessage({protocol,type:'terminal-cancel',id});return}
        this.#pending.delete(id)
        clearTimeout(timer)
        cleanup()
        cancelOperation()
        reject(signal!.reason)
      }
      signal?.addEventListener('abort',abort,{once:true})
      const cleanup=()=>signal?.removeEventListener('abort',abort)
      const timer=timeoutMs===0?undefined:setTimeout(()=>{
        this.#pending.delete(id)
        cleanup()
        reject(Error(`Owner ${operation} did not accept the request`))
      },30000)
      this.#pending.set(id,{resolve,reject,timer,timeoutMs,operation,onOutput,cleanup})
      try{this.#port.postMessage({protocol,type:'request',id,operation,...fields},transfer)}
      catch(error){
        clearTimeout(timer);cleanup()
        this.#pending.delete(id)
        reject(error)
      }
    })
  }
  subscribeEvents(listener:(event:NativeDevServerEvent)=>void){
    this.#listeners.add(listener)
    return ()=>{this.#listeners.delete(listener)}
  }
  start(files:Record<string,string|Uint8Array>,options:OwnerOptions={}){
    return this.#call<number>('start',{files,options},240000)
  }
  restoreCheckpoint(key:string,options:OwnerOptions={}){
    return this.#call<number>('restore',{key,options})
  }
  restart(){return this.#call<number>('restart',{},240000)}
  reinstall(){return this.#call<number>('reinstall',{},240000)}
  installResult(){return this.#call<ProjectInstallResult>('installResult')}
  resources(){return this.#call<NativeOwnerResourceSnapshot>('resources')}
  writeFile(path:string,bytes:string|Uint8Array){return this.#call<void>('writeFile',{path,bytes})}
  workspaceRevision(){return this.#call<number>('workspaceRevision')}
  readFile(path:string){return this.#call<Uint8Array>('readFile',{path})}
  mkdir(path:string,options:{recursive?:boolean;mode?:number}={}){return this.#call<void>('mkdir',{path,options})}
  rename(from:string,to:string){return this.#call<void>('rename',{from,to})}
  remove(path:string,options:{recursive?:boolean;force?:boolean}={}){return this.#call<void>('remove',{path,options})}
  listDirectory(path:string){return this.#call<Array<{name:string,type:'file'|'directory'|'symlink'}>>('listDirectory',{path})}
  listTerminalCommands(){return this.#call<string[]>('listTerminalCommands')}
  terminalCommand(line:string,cwd='/project',onOutput?:NativeTerminalOutput,signal?:AbortSignal,shellState?:string,
    size?:{columns:number;rows:number}){
    return this.#call<Awaited<ReturnType<NativeDevServer['terminalCommand']>>>(
      'terminalCommand',{line,cwd,shellState,size},0,[],onOutput,signal)
  }
  /** Open one foreground shell command with its own bounded stdin channel. */
  openTerminalCommand(line:string,cwd='/project',onOutput?:NativeTerminalOutput,shellState?:string,
    size?:{columns:number;rows:number}){
    const channel=new MessageChannel()
    const controller=new AbortController()
    const inputSender=new NativeTerminalInputSender(channel.port1)
    let ended=false
    const result=this.#call<Awaited<ReturnType<NativeDevServer['terminalCommand']>>>(
      'terminalCommand',{line,cwd,shellState,size},0,[channel.port2],onOutput,controller.signal)
      .finally(()=>{ended=true;inputSender.close();channel.port1.close()})
    return {
      result,
      writeInputAcknowledged:(value:string|Uint8Array)=>inputSender.write(value),
      writeInput:(value:string|Uint8Array)=>{
        if(ended)throw Error('Terminal input is closed')
        const bytes=typeof value==='string'?new TextEncoder().encode(value):value
        if(!(bytes instanceof Uint8Array)||bytes.byteLength===0||bytes.byteLength>65536)throw Error('Invalid terminal input chunk')
        channel.port1.postMessage({type:'data',bytes})
      },
      endInput:()=>{if(!ended){ended=true;inputSender.close();channel.port1.postMessage({type:'end'})}},
      resize:(columns:number,rows:number)=>{
        if(ended)throw Error('Terminal input is closed')
        if(!Number.isSafeInteger(columns)||columns<1||columns>1000||!Number.isSafeInteger(rows)||rows<1||rows>1000)
          throw Error('Invalid terminal size')
        channel.port1.postMessage({type:'resize',columns,rows})
      },
      interrupt:()=>{inputSender.close();controller.abort()},
    }
  }
  /** Open an interactive shell that keeps interpreter state between prompts. */
  async openTerminalSession(cwd='/project'){
    const sessionId=await this.#call<number>('terminalSessionOpen',{cwd})
    let closed=false
    return {
      runCommand:(line:string,onOutput?:NativeTerminalOutput,size?:{columns:number;rows:number})=>{
        if(closed)throw Error('Terminal session closed')
        const channel=new MessageChannel()
        const controller=new AbortController()
        let ended=false
        const result=this.#call<Awaited<ReturnType<NativeDevServer['terminalCommand']>>>(
          'terminalSessionRun',{sessionId,line,size},0,[channel.port2],onOutput,controller.signal)
          .finally(()=>{ended=true;channel.port1.close()})
        return {
          result,
          writeInput:(value:string|Uint8Array)=>{
            if(ended)throw Error('Terminal input is closed')
            const bytes=typeof value==='string'?new TextEncoder().encode(value):value
            if(!(bytes instanceof Uint8Array)||bytes.byteLength===0||bytes.byteLength>65536)throw Error('Invalid terminal input chunk')
            channel.port1.postMessage({type:'data',bytes})
          },
          endInput:()=>{if(!ended){ended=true;channel.port1.postMessage({type:'end'})}},
          resize:(columns:number,rows:number)=>{
            if(ended)throw Error('Terminal input is closed')
            if(!Number.isSafeInteger(columns)||columns<1||columns>1000||!Number.isSafeInteger(rows)||rows<1||rows>1000)
              throw Error('Invalid terminal size')
            channel.port1.postMessage({type:'resize',columns,rows})
          },
          interrupt:()=>controller.abort(),
        }
      },
      dispose:async()=>{
        if(closed)return
        closed=true
        await this.#call<void>('terminalSessionClose',{sessionId})
      },
    }
  }
  saveCheckpoint(key:string){return this.#call<CheckpointMetadata>('saveCheckpoint',{key})}
  snapshotWorkspace(){return this.#call<Extract<WorkspaceSnapshot,{version:5}>>('snapshotWorkspace')}
  restoreWorkspace(snapshot:Extract<WorkspaceSnapshot,{version:5}>){return this.#call<number>('restoreWorkspace',{snapshot},240000)}
  build(options:{ssr?:boolean}={}){return this.#call<string[]>('build',{options},240000)}
  typecheck(){return this.#call<Awaited<ReturnType<NativeDevServer['typecheck']>>>('typecheck',{},240000)}
  runBuildScript(name='build'){
    return this.#call<Awaited<ReturnType<NativeDevServer['runBuildScript']>>>('runBuildScript',{name},360000)
  }
  ports(){return this.#call<number[]>('ports')}
  hmrURL(){return this.#call<string>('hmrURL')}
  async connectWebSocket(origin:string,url:string,protocols:string[]=[]){
    const channel=new MessageChannel()
    try{
      const result=await this.#call<{protocol:string}>('websocket-connect',
        {origin,url,protocols},30000,[channel.port2])
      return new NativeOwnerWebSocket(channel.port1,result.protocol)
    }catch(error){channel.port1.close();throw error}
  }
  /** HTTP response bodies cross the owner boundary one pulled chunk at a time. */
  async fetch(request:Request):Promise<Response>{
    request.signal.throwIfAborted()
    const channel=new MessageChannel()
    const controller=new AbortController()
    let finished=false
    let bodyController:ReadableStreamDefaultController<Uint8Array>|undefined
    let completePull:(()=>void)|undefined
    const forwardAbort=()=>controller.abort(request.signal.reason)
    const cleanup=()=>{
      finished=true
      request.signal.removeEventListener('abort',forwardAbort)
      controller.signal.removeEventListener('abort',abort)
      this.#httpRequests.delete(cancel)
      channel.port1.close()
      completePull?.();completePull=undefined
    }
    const cancel=(reason:unknown)=>{
      if(finished)return
      finished=true
      channel.port1.postMessage({type:'cancel'})
      bodyController?.error(reason)
      controller.abort(reason)
      cleanup()
    }
    const abort=()=>cancel(controller.signal.reason)
    request.signal.addEventListener('abort',forwardAbort,{once:true})
    controller.signal.addEventListener('abort',abort,{once:true})
    this.#httpRequests.add(cancel)
    try{
      let body:Uint8Array|undefined
      if(!['GET','HEAD'].includes(request.method)){
        if(request.body){
          const reader=request.body.getReader(),chunks:Uint8Array[]=[]
          let size=0
          try{
            for(;;){
              const next=await abortableWait(reader.read(),controller.signal)
              if(next.done)break
              size+=next.value.byteLength
              if(size>16*1024*1024)throw Error('HTTP request body exceeds 16 MiB')
              chunks.push(next.value)
            }
          }catch(error){void reader.cancel(error).catch(()=>{});throw error}
          finally{reader.releaseLock()}
          body=new Uint8Array(size)
          let offset=0
          for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength}
        }else{
          body=new Uint8Array(await abortableWait(request.arrayBuffer(),controller.signal))
          if(body.byteLength>16*1024*1024)throw Error('HTTP request body exceeds 16 MiB')
        }
      }
      const result=await this.#call<{status:number;statusText:string;headers:[string,string][];hasBody:boolean}>(
        'fetch',{url:request.url,method:request.method,headers:[...request.headers],body},120000,[channel.port2],
        undefined,controller.signal,abort)
      controller.signal.throwIfAborted()
      if(!result.hasBody){cleanup();return new Response(null,result)}
      const stream=new ReadableStream<Uint8Array>({
        start(streamController){
          bodyController=streamController
          channel.port1.onmessage=({data})=>{
            if(finished)return
            if(data?.type==='chunk'){
              streamController.enqueue(data.bytes as Uint8Array)
              completePull?.();completePull=undefined
            }else if(data?.type==='done'){
              streamController.close();cleanup()
            }else if(data?.type==='error'){
              streamController.error(Error(data.error));cleanup()
            }
          }
          channel.port1.start()
        },
        pull(){
          return new Promise<void>(resolve=>{
            completePull=resolve
            channel.port1.postMessage({type:'pull'})
          })
        },
        cancel(reason){cancel(reason)},
      },{highWaterMark:0})
      return new Response(stream,result)
    }catch(error){cancel(error);channel.port2.close();throw error}
  }
  async dispose(){await this.#call<void>('dispose')}
  close(){
    if(this.#closed)return
    this.#closed=true
    for(const cancel of this.#httpRequests)cancel(Error('Owner channel closed'))
    this.#port.close()
    for(const pending of this.#pending.values()){
      clearTimeout(pending.timer)
      pending.cleanup?.()
      pending.reject(Error('Owner channel closed'))
    }
    this.#pending.clear()
    this.#listeners.clear()
  }
}

/** A guest WebSocket carried over a dedicated owner message channel. */
export class NativeOwnerWebSocket{
  #next=0
  #pending=new Map<number,Pending>()
  #closed=false
  constructor(readonly port:MessagePort,readonly protocol:string){
    port.onmessage=({data})=>{
      if(data?.protocol!==ownerChannelProtocol||data.type!=='response')return
      const pending=this.#pending.get(data.id)
      if(!pending)return
      this.#pending.delete(data.id)
      clearTimeout(pending.timer)
      data.ok?pending.resolve(data.value):pending.reject(Error(data.error))
    }
    port.start()
  }
  #call<T>(operation:string,fields:Record<string,unknown>={}):Promise<T>{
    if(this.#closed)return Promise.reject(Error('Owner WebSocket closed'))
    return new Promise((resolve,reject)=>{
      const id=++this.#next
      const timer=setTimeout(()=>{
        this.#pending.delete(id)
        reject(Error(`Owner WebSocket ${operation} timed out`))
      },120000)
      this.#pending.set(id,{resolve,reject,timer})
      try{this.port.postMessage({protocol,type:'request',id,operation,...fields})}
      catch(error){clearTimeout(timer);this.#pending.delete(id);reject(error)}
    })
  }
  send(data:string|Uint8Array){return this.#call<void>('send',{data})}
  next(){return this.#call<Awaited<ReturnType<WorkerWebSocket['next']>>>('next')}
  close(code=1000,reason=''){return this.#call<void>('close',{code,reason})}
  async dispose(){
    if(this.#closed)return
    try{await this.#call<void>('dispose')}
    finally{
      this.#closed=true
      this.port.close()
      for(const pending of this.#pending.values()){
        clearTimeout(pending.timer);pending.reject(Error('Owner WebSocket closed'))
      }
      this.#pending.clear()
    }
  }
}
