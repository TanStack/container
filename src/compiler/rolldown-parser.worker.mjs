import {instantiateNapiModule,WASI,emnapiAsyncWorkPlugin,emnapiTSFNPlugin,createOnMessage} from '@napi-rs/wasm-runtime'
import {createContext} from '@emnapi/runtime'
import {memfs} from '@napi-rs/wasm-runtime/fs'
import {rolldownParserPolicy,rolldownCompilerResources} from './rolldown-parser-policy'
import pinned from './rolldown-parser-inputs.json'
import {restoreCompilerWorkspace} from './restore-compiler-workspace'
import {callableLimits,callableWorkspaceLimits,restoreCallableDescriptor,validateCallableHookArguments} from './rolldown-callable-protocol'
import {NativeBundlerBackend} from './rolldown-bundler-backend'
import {snapshotBindingResult,encodeBindingSnapshot} from './rolldown-binding-output.js'
import {synchronizeBundlerWorkspace,captureBundlerFiles,guardBundlerWrites} from './rolldown-bundler-workspace'
import {updateCallableWorkspace} from './callable-workspace-update'
const bundlerReplies=new Map()
let bundlers,nextBundlerCallback=0
const children=new Set()
const plugins=new Map(),ownedFiles=new Set()
let started=false,closed=false,binding,policy,profile,limits,fs,resolver,workspaceBytes=0,nextHandle=0,nextTsconfigCache=0,queue=Promise.resolve(),created=0,peak=0
const tsconfigCaches=new Map()
const resources=()=>({created,peak,active:children.size,sharedInitialBytes:limits.initialPages*65536,sharedMaximumBytes:limits.maximumPages*65536})
const describe=error=>(String(error)+'\n'+String(error?.stack??'')).slice(0,12000)
async function close(){if(closed)return;closed=true;plugins.clear();try{if(bundlers)await bundlers.closeAll();if(binding)await binding.shutdownAsyncRuntime()}finally{for(const worker of children)worker.terminate();children.clear()}}
function syncReply(data,value,error){
  const header=new Int32Array(data.buffer,0,4)
  let failed=Boolean(error),text
  try{text=JSON.stringify(error?{error:describe(error)}:{value})}catch(cause){text=JSON.stringify({error:describe(cause)});failed=true}
  let bytes=new TextEncoder().encode(text)
  if(bytes.length>policy.maxSourceBytes){bytes=new TextEncoder().encode('{"error":"Native compiler synchronous reply byte ceiling"}');failed=true}
  new Uint8Array(data.buffer,16,bytes.length).set(bytes);Atomics.store(header,1,bytes.length);Atomics.store(header,0,failed?2:1);Atomics.notify(header,0)
}
function synchronous(data){
  if(closed||!binding)throw Error('Native parser is not ready')
  if(!(data.buffer instanceof SharedArrayBuffer)||data.buffer.byteLength!==policy.maxSourceBytes+16)throw Error('Invalid native compiler synchronous buffer')
  if(data.command==='create-tsconfig-cache'){
    if(data.pathToTsconfig!==undefined&&typeof data.pathToTsconfig!=='string')throw Error('Invalid tsconfig path')
    const handle=++nextTsconfigCache;tsconfigCaches.set(handle,new binding.TsconfigCache(false,data.pathToTsconfig));return handle
  }
  if(['clear-tsconfig-cache','tsconfig-cache-size'].includes(data.command)&&!Number.isSafeInteger(data.handle))throw Error('Invalid tsconfig cache handle')
  if(data.command==='clear-tsconfig-cache'){const cache=tsconfigCaches.get(data.handle);if(!cache)throw Error('Unknown tsconfig cache');cache.clear();return}
  if(data.command==='tsconfig-cache-size'){const cache=tsconfigCaches.get(data.handle);if(!cache)throw Error('Unknown tsconfig cache');return cache.size()}
  if(data.command==='transform'){
    if(typeof data.filename!=='string'||data.filename.length>4096||typeof data.source!=='string'||new TextEncoder().encode(data.source).byteLength>policy.maxSourceBytes)throw Error('Native transform input exceeds owner policy')
    const cache=data.cache===undefined?undefined:tsconfigCaches.get(data.cache)
    if(data.cache!==undefined&&!cache)throw Error('Unknown tsconfig cache')
    return binding.enhancedTransformSync(data.filename,data.source,data.options,cache,false)
  }
  if(data.command==='parse'){
    if(typeof data.filename!=='string'||data.filename.length>4096||typeof data.source!=='string'||new TextEncoder().encode(data.source).byteLength>policy.maxSourceBytes)throw Error('Native parser input exceeds owner policy')
    const options=data.options
    if(options!==undefined&&(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>!['lang','sourceType','preserveParens'].includes(key))))throw Error('Unsupported native parser options')
    const result=binding.parseSync(data.filename,data.source,options)
    return {program:result.program,module:result.module,comments:result.comments,errors:result.errors}
  }
  throw Error('Unsupported native compiler synchronous command')
}
function bundlerCallback(callbackId,args,scope,sync){
  if(closed||bundlerReplies.size>=callableLimits.maxBundlerCallbacks)throw Error('Native bundler callback ceiling')
  const request=++nextBundlerCallback
  if(sync){
    const buffer=new SharedArrayBuffer(policy.maxSourceBytes+16),header=new Int32Array(buffer,0,4)
    postMessage({type:'bundler-callback',request,callbackId,args,scope,sync:true,buffer})
    if(Atomics.wait(header,0,0,policy.timeoutMs)==='timed-out')throw Error('Native bundler synchronous callback deadline')
    const size=Atomics.load(header,1)
    if(size<0||size>policy.maxSourceBytes)throw Error('Invalid native bundler callback reply')
    const reply=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,16,size).slice()))
    if(Atomics.load(header,0)!==1)throw Error(reply.error)
    return reply.value
  }
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{bundlerReplies.delete(request);reject(Error('Native bundler callback deadline'))},policy.timeoutMs)
    bundlerReplies.set(request,{resolve,reject,timer,scope})
    postMessage({type:'bundler-callback',request,callbackId,args,scope,sync:false})
  })
}
async function bundlerCommand(data){
  if(!bundlers)throw Error('Native bundler requires owner workspace')
  if(data.command==='create')return bundlers.create()
  if(data.command==='run'){
    if(data.snapshot){const restored=synchronizeBundlerWorkspace(fs,data.snapshot,resolver);workspaceBytes=restored.bytes;ownedFiles.clear();for(const path of restored.files)ownedFiles.add(path)}
    const before=data.method==='write'?captureBundlerFiles(fs,resolver):undefined
    const unguard=guardBundlerWrites(fs,resolver)
    let result
    try{result=await bundlers.run(data.handle,data.method,data.options)}finally{unguard()}
    const after=data.method==='write'?captureBundlerFiles(fs,resolver):undefined
    const files=after?Object.fromEntries(Object.entries(after).filter(([path,bytes])=>!before[path]||bytes.length!==before[path].length||bytes.some((byte,index)=>byte!==before[path][index]))):{}
    const previousFiles=Object.fromEntries(Object.keys(files).map(path=>[path,before[path]??null]))
    return {...result,files,previousFiles}
  }
  if(data.command==='close')return await bundlers.close(data.handle)
  if(data.command==='context')return await bundlers.invokeContext(data.scope,data.handle,data.method,data.args)
  throw Error('Unsupported native bundler command')
}
function callback(handle,method,args){
  if(closed)throw Error('Native callable session is closed')
  if(new TextEncoder().encode(JSON.stringify(args)).length>callableLimits.maxCallbackBytes)throw Error('Callback arguments exceed byte ceiling')
  const buffer=new SharedArrayBuffer(callableLimits.maxCallbackBytes+16),header=new Int32Array(buffer,0,4)
  postMessage({type:'callback',handle,method,args,buffer})
  if(Atomics.wait(header,0,0,policy.timeoutMs)==='timed-out')throw Error('Guest synchronous callback deadline exceeded')
  const length=Atomics.load(header,1),status=Atomics.load(header,0)
  if(length<0||length>callableLimits.maxCallbackBytes)throw Error('Invalid callback reply size')
  const result=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,16,length).slice()))
  if(status!==1)throw Error(result.error||'Guest callback cancelled')
  if(result.kind==='undefined')return undefined
  if(result.kind==='null')return null
  if(result.kind==='string'&&typeof result.value==='string')return result.value
  throw Error('Unsupported synchronous callback return')
}
async function callable(data){
  if(!resolver)throw Error('Native callable resolver is disabled')
  if(data.command==='create'){
    if(plugins.size>=callableLimits.maxHandles)throw Error('Native callable handle ceiling')
    const handle=++nextHandle
    const descriptor=restoreCallableDescriptor(data.descriptor,(method,args)=>callback(handle,method,args))
    const plugin=new binding.BindingCallableBuiltinPlugin(descriptor),hooks=[]
    for(const name in plugin)hooks.push({name,order:plugin.getOrder(name)})
    plugins.set(handle,plugin);return {handle,hooks}
  }
  if(!Number.isSafeInteger(data.handle)||!plugins.has(data.handle))throw Error('Unknown native callable handle')
  const plugin=plugins.get(data.handle)
  if(data.command==='dispose'){plugins.delete(data.handle);return}
  if(data.command==='invoke'){
    if(!['load','transform'].includes(data.method)||!Array.isArray(data.args)||new TextEncoder().encode(JSON.stringify(data.args)).byteLength>policy.maxSourceBytes)throw Error('Unsupported callable hook arguments')
    validateCallableHookArguments(data.method,data.args)
    const result=await plugin[data.method](...data.args)
    if(new TextEncoder().encode(JSON.stringify(result)??'').byteLength>policy.maxSourceBytes)throw Error('Callable hook output exceeds owner policy')
    return result
  }
  if(data.command==='resolve'){
    if(typeof data.specifier!=='string'||data.specifier.length>4096||typeof data.importer!=='string'||data.importer.length>4096)throw Error('Invalid callable resolve input')
    return await plugin.resolveId(data.specifier,data.importer,data.options)
  }
  if(data.command==='update'){
    updateCallableWorkspace(fs,data.path,data.bytes,data.event,resolver)
    await plugin.watchChange(data.path,{event:data.event})
    return {written:data.path}
  }
  throw Error('Unsupported callable command')
}
globalThis.onmessage=async({data})=>{
  if(data?.type==='sync'){
    try{syncReply(data,synchronous(data))}catch(error){if(data?.buffer instanceof SharedArrayBuffer)syncReply(data,undefined,error)}return
  }
  if(data?.type==='bundler-callback-reply'){
    const pending=bundlerReplies.get(data.request)
    if(!pending)return
    clearTimeout(pending.timer);bundlerReplies.delete(data.request)
    data.error?pending.reject(Error(String(data.error))):pending.resolve(data.value);return
  }
  if(data?.scope!==undefined&&(data.type==='callable'||data.type==='bundler')){
    // Only operations belonging to an outstanding async callback can bypass
    // the build queue. Ordinary concurrent work never enters this lane.
    const allowed=bundlers?.hasScope(data.scope)&&[...bundlerReplies.values()].some(reply=>reply.scope===data.scope)&&((data.type==='callable'&&['create','resolve','invoke'].includes(data.command))||(data.type==='bundler'&&data.command==='context'))
    if(!allowed){postMessage({type:'result',id:data.id,error:'Unsupported nested native compiler operation'});return}
    try{const value=await(data.type==='callable'?callable(data):bundlerCommand(data));postMessage({type:'result',id:data.id,value})}catch(error){postMessage({type:'result',id:data.id,error:describe(error)})}return
  }
  if(data?.type==='abort'){
    // Do not await native shutdown when a native operation has already failed
    // its deadline. Explicitly stop owned threads while this worker can run.
    closed=true;plugins.clear();for(const worker of [...children])worker.terminate();children.clear()
    for(const pending of bundlerReplies.values()){clearTimeout(pending.timer);pending.reject(Error('Native compiler cancelled'))}bundlerReplies.clear()
    postMessage({type:'closed',resources:resources()});return
  }
  if(data?.type==='close'){try{await close();postMessage({type:'closed',resources:resources()})}catch(error){postMessage({type:'error',error:describe(error)})}return}
  if(data?.type==='parse'||data?.type==='callable'||data?.type==='bundler'){
    if(profile==='sync'){postMessage({type:'result',id:data.id,error:'Synchronous compiler profile does not accept asynchronous operations'});return}
    queue=queue.then(async()=>{
      if(closed||!binding)throw Error('Native parser is not ready')
      if(!Number.isSafeInteger(data.id))throw Error('Invalid native compiler request')
      if(data.type==='callable')return await callable(data)
      if(data.type==='bundler')return await bundlerCommand(data)
      if(!Number.isSafeInteger(data.id)||typeof data.filename!=='string'||data.filename.length>4096||typeof data.source!=='string'||new TextEncoder().encode(data.source).byteLength>policy.maxSourceBytes)throw Error('Native parser input exceeds owner policy')
      const options=data.options
      if(options!==undefined&&(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>!['lang','sourceType','preserveParens'].includes(key))||options.lang!==undefined&&!['js','jsx','ts','tsx'].includes(options.lang)||options.sourceType!==undefined&&!['script','module','commonjs','unambiguous'].includes(options.sourceType)||options.preserveParens!==undefined&&typeof options.preserveParens!=='boolean'))throw Error('Unsupported native parser options')
      const result=await binding.parse(data.filename,data.source,options)
      return {program:result.program,module:result.module,comments:result.comments,errors:result.errors}
    }).then(value=>{if(!closed)postMessage({type:'result',id:data.id,value})},error=>{if(!closed)postMessage({type:'result',id:data.id,error:describe(error)})})
    return
  }
  if(data?.type!=='start'||started){postMessage({type:'error',error:'Unsupported native parser command'});return}
  started=true
  try{
    policy=rolldownParserPolicy(data.policy)
    if(!policy)throw Error('Native parser requires explicit owner policy')
    if(!['full','sync'].includes(data.profile))throw Error('Invalid native compiler profile')
    profile=data.profile
    limits=rolldownCompilerResources(profile)
    if(profile==='sync'&&data.resolver)throw Error('Synchronous compiler profile does not accept a resolver')
    if(!crossOriginIsolated||typeof SharedArrayBuffer==='undefined')throw Error('Native parser requires COI and SAB')
    for(const value of [data.wasmURL,data.pthreadURL]){
      const url=new URL(value)
      if(!['http:','https:'].includes(url.protocol)||url.origin!==location.origin||url.username||url.password||url.hash)throw Error('Native parser assets must be same-origin HTTP URLs')
    }
    fs=memfs().fs
    if(data.resolver){
      resolver=callableWorkspaceLimits(data.resolver.maxBytes,data.resolver.maxFiles)
      const restored=restoreCompilerWorkspace(fs,data.resolver.snapshot,resolver);workspaceBytes=restored.bytes
      for(const path of Object.keys(data.resolver.snapshot.files))ownedFiles.add(path)
    }
    const memory=new WebAssembly.Memory({initial:limits.initialPages,maximum:limits.maximumPages,shared:true})
    const wasi=new WASI({version:'preview1',fs,preopens:{'/':'/'}})
    const context=createContext({autoDestroy:false});context.suppressDestroy()
    const response=await fetch(data.wasmURL)
    if(!response.ok)throw Error('Native parser asset unavailable')
    const bytes=await response.arrayBuffer()
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('')
    if(hash!==pinned.inputs['@rolldown/binding-wasm32-wasi/rolldown-binding.wasm32-wasi.wasm'])throw Error('Native parser WASM hash mismatch')
    if(closed)return
    const {napiModule}=await instantiateNapiModule(bytes,{
      context,wasi,asyncWorkPoolSize:limits.asyncWorkPoolSize,reuseWorker:true,plugins:[emnapiAsyncWorkPlugin,emnapiTSFNPlugin],
      onCreateWorker(){
        if(closed)throw Error('Native compiler session is closed')
        if(children.size>=limits.maxWorkers)throw Error('Native parser worker ceiling reached')
        const worker=new Worker(data.pthreadURL,{type:'module'});children.add(worker);created++;peak=Math.max(peak,children.size)
        worker.addEventListener('message',createOnMessage(fs))
        const terminate=worker.terminate.bind(worker);worker.terminate=()=>{children.delete(worker);terminate()}
        return worker
      },
      overwriteImports(imports){imports.env={...imports.env,...imports.napi,...imports.emnapi,memory};return imports},
      beforeInit({instance}){for(const name of Object.keys(instance.exports))if(name.startsWith('__napi_register__'))instance.exports[name]()},
    })
    if(closed)return
    binding=napiModule.exports
    if(resolver)bundlers=new NativeBundlerBackend(binding,{asyncCallback:(id,args,scope)=>bundlerCallback(id,args,scope,false),syncCallback:(id,args,scope)=>bundlerCallback(id,args,scope,true)},resolver.maxBytes,result=>encodeBindingSnapshot(snapshotBindingResult(result),resolver.maxBytes))
    postMessage({type:'ready'})
  }catch(error){await close();postMessage({type:'error',error:describe(error)})}
}
