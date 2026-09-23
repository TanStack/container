import {instantiateNapiModule,WASI,emnapiAsyncWorkPlugin,emnapiTSFNPlugin,createOnMessage} from '@napi-rs/wasm-runtime'
import {createContext} from '@emnapi/runtime'
import {memfs} from '@napi-rs/wasm-runtime/fs'
import {restoreCompilerWorkspace} from '../../../src/compiler/restore-compiler-workspace'

const children=new Set()
let binding,plugin,fs,started=false,closed=false,created=0,peak=0,callbackCount=0,resolveCalls=0,watchChanges=0,workspaceBytes=0,queue=Promise.resolve()
const operations=[],ownedFiles=new Set()
const resources=()=>({created,peak,active:children.size,callbackCount,resolveCalls,watchChanges,pluginInstances:plugin?1:0,operations:[...operations],sharedInitialBytes:1073741824,sharedMaximumBytes:1342177280})
const describe=error=>(String(error)+'\n'+String(error?.stack??'')).slice(0,12000)
function callback(method,args){
  if(closed)throw Error('Callable resolver session is closed')
  if(++callbackCount>128)throw Error('Callable resolver callback ceiling')
  const buffer=new SharedArrayBuffer(65536+16),header=new Int32Array(buffer,0,4)
  postMessage({type:'callback',method,args,buffer})
  const waited=Atomics.wait(header,0,0,30000)
  if(waited==='timed-out')throw Error('Guest synchronous callback deadline exceeded')
  const length=Atomics.load(header,1),status=Atomics.load(header,0)
  if(length<0||length>65536)throw Error('Invalid callback reply size')
  const result=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,16,length).slice()))
  if(status!==1)throw Error(result.error||'Guest callback cancelled')
  if(result.kind==='undefined')return undefined
  if(result.kind==='null')return null
  if(result.kind==='string'&&typeof result.value==='string')return result.value
  throw Error('Unsupported synchronous callback return')
}
async function close(){
  if(closed)return resources()
  closed=true
  try{if(binding)await binding.shutdownAsyncRuntime()}finally{for(const worker of [...children])worker.terminate();children.clear()}
  return resources()
}
globalThis.onmessage=({data})=>{
  if(data.type==='abort'){void close().then(resources=>postMessage({type:'closed',resources}),error=>postMessage({type:'closed',error:describe(error)}));return}
  if(data.type==='command'){
    queue=queue.then(async()=>{
      if(closed||!binding||!plugin)throw Error('Callable resolver is not ready')
      if(operations.length>=128)throw Error('Callable resolver operation ceiling')
      if(data.command==='resolve'){
        const result=await plugin.resolveId(data.id,data.importer,data.options)
        resolveCalls++;operations.push({type:'resolve',id:data.id,result})
        return result
      }
      if(data.command==='update'){
        if(typeof data.path!=='string'||!ownedFiles.has(data.path)||typeof data.source!=='string'||data.event!=='update')throw Error('Unsupported owned workspace update')
        const bytes=new TextEncoder().encode(data.source),previous=fs.statSync(data.path).size
        if(bytes.length>65536||workspaceBytes-previous+bytes.length>1024*1024)throw Error('Workspace update exceeds byte ceiling')
        fs.writeFileSync(data.path,bytes);workspaceBytes=workspaceBytes-previous+bytes.length
        operations.push({type:'write',path:data.path})
        await plugin.watchChange(data.path,{event:data.event})
        watchChanges++;operations.push({type:'watchChange',path:data.path,event:data.event})
        return {written:data.path,watchChanges}
      }
      if(data.command==='close')return await close()
      throw Error('Unsupported callable resolver command')
    }).then(value=>postMessage({type:'result',request:data.request,value}),error=>postMessage({type:'result',request:data.request,error:describe(error)}))
    return
  }
  if(data.type!=='start'||started){postMessage({type:'error',error:'Unsupported callable resolver message'});return}
  started=true
  void(async()=>{
    if(!crossOriginIsolated||typeof SharedArrayBuffer==='undefined')throw Error('Callable resolver requires COI and SAB')
    fs=memfs().fs
    const restored=restoreCompilerWorkspace(fs,data.snapshot,{maxBytes:1024*1024,maxFiles:128})
    workspaceBytes=restored.bytes
    for(const path of Object.keys(data.snapshot.files))ownedFiles.add(path)
    const memory=new WebAssembly.Memory({initial:16384,maximum:20480,shared:true})
    const wasi=new WASI({version:'preview1',fs,preopens:{'/':'/'}})
    const context=createContext({autoDestroy:false});context.suppressDestroy()
    const response=await fetch('/compiler.wasm')
    if(!response.ok)throw Error('Pinned WASM unavailable')
    const bytes=await response.arrayBuffer()
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('')
    if(hash!==data.wasmSHA256)throw Error('Pinned WASM hash mismatch')
    const {napiModule}=await instantiateNapiModule(bytes,{
      context,wasi,asyncWorkPoolSize:4,reuseWorker:true,plugins:[emnapiAsyncWorkPlugin,emnapiTSFNPlugin],
      onCreateWorker(){
        if(children.size>=8)throw Error('Native resolver worker ceiling reached')
        const worker=new Worker('/pthread.js',{type:'module'});children.add(worker);created++;peak=Math.max(peak,children.size)
        worker.addEventListener('message',createOnMessage(fs))
        const terminate=worker.terminate.bind(worker);worker.terminate=()=>{children.delete(worker);terminate()}
        return worker
      },
      overwriteImports(imports){imports.env={...imports.env,...imports.napi,...imports.emnapi,memory};return imports},
      beforeInit({instance}){for(const name of Object.keys(instance.exports))if(name.startsWith('__napi_register__'))instance.exports[name]()},
    })
    binding=napiModule.exports
    const restore=value=>{
      if(!value||typeof value!=='object')return value
      if(value.type==='RegExp')return new RegExp(value.source,value.flags)
      if(value.type==='callback')return undefined
      if(Array.isArray(value))return value.map(restore)
      return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,restore(item)]))
    }
    const descriptor=restore(data.descriptor)
    for(const name of data.callbacks)descriptor.options[name]=(...args)=>callback(name,args)
    plugin=new binding.BindingCallableBuiltinPlugin(descriptor)
    const hooks=[]
    for(const name in plugin)hooks.push({name,order:plugin.getOrder(name)})
    postMessage({type:'ready',hooks,resources:resources()})
  })().catch(async error=>{await close();postMessage({type:'error',error:describe(error)})})
}
