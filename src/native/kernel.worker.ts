import {Buffer} from 'buffer'
import {Volume,createFsFromVolume} from 'memfs'
import {IncomingRequest} from '../sandbox/incoming-request'
import {installNativeAsyncContext,NativeAsyncLocalStorage} from './async-context'
import {VolumeFileSystem} from './volume-file-system'
import {installLockedPackages} from '../npm/install'
import type {RuntimeLock} from '../npm/types'
import {compileProject,initializeCompiler,stopCompiler} from '../compiler/compile'
import {lowerNativeModule} from '../feasibility/native-lowering'

Object.assign(globalThis,{Buffer})

type FileValue = string | Uint8Array
type RequestMessage = {
  id:number
  operation:'initialize'|'install'|'load'|'loadEntry'|'request'|'readFile'|'writeFile'|'snapshot'
  files?:Record<string,FileValue>
  code?:string
  entry?:string
  asyncContext?:boolean
  path?:string
  bytes?:Uint8Array
  url?:string
  method?:string
  headers?:HeadersInit
  body?:string
  lock?:RuntimeLock
}

let volume:InstanceType<typeof Volume>|undefined
let handler:((request:Request)=>Response|Promise<Response>)|undefined
let moduleURL:string|undefined

self.onmessage = async ({data}:{data:RequestMessage})=>{
  const {id}=data
  try {
    let value:unknown
    switch(data.operation){
      case 'initialize':{
        volume=Volume.fromJSON(Object.fromEntries(Object.entries(data.files??{}).filter((entry):entry is [string,string]=>typeof entry[1]==='string')))
        for(const [path,bytes] of Object.entries(data.files??{})){
          if(typeof bytes==='string')continue
          volume.mkdirSync(path.slice(0,path.lastIndexOf('/'))||'/',{recursive:true})
          volume.writeFileSync(path,bytes)
        }
        value=null
        break
      }
      case 'install':{
        if(!volume||!data.lock)throw Error('Filesystem not initialized or lock missing')
        await installLockedPackages(new VolumeFileSystem(volume),data.lock)
        value={packages:data.lock.packages.length}
        break
      }
      case 'loadEntry':{
        if(!volume||!data.entry)throw Error('Filesystem not initialized or entry missing')
        await initializeCompiler(false)
        try{
          const compiled=await compileProject(new VolumeFileSystem(volume),data.entry)
          data.code=(await lowerNativeModule(compiled.code)).code
        }finally{await stopCompiler()}
        // The compiled module is loaded through the same path as a supplied
        // bundle, and the current worker-owned volume stays in place.
      }
      case 'load': {
        if(!data.code)throw Error('Missing bundled module code')
        if(moduleURL)URL.revokeObjectURL(moduleURL)
        handler=undefined
        if(data.files!==undefined||!volume){
          volume=Volume.fromJSON(Object.fromEntries(Object.entries(data.files??{}).filter((entry):entry is [string,string]=>typeof entry[1]==='string')))
          for(const [path,bytes] of Object.entries(data.files??{})){
            if(typeof bytes==='string')continue
            volume.mkdirSync(path.slice(0,path.lastIndexOf('/'))||'/',{recursive:true})
            volume.writeFileSync(path,bytes)
          }
        }
        const fs=createFsFromVolume(volume)
        if(data.asyncContext)installNativeAsyncContext()
        const fsSync=Object.fromEntries(Object.keys(fs).filter(key=>key.endsWith('Sync')).map(key=>[key.slice(0,-4),(...args:unknown[])=>(fs as unknown as Record<string,(...args:unknown[])=>unknown>)[key](...args)]))
        // The native worker owns its filesystem. Guest adapters use this bridge
        // without a cross-worker synchronous RPC or access to the host page.
        Object.defineProperty(globalThis,'__webContainerHost',{value:{
          env:{NODE_ENV:'production'},argv:[],fs:fs.promises,fsSync,
          AsyncLocalStorage:NativeAsyncLocalStorage,
          randomBytes:(size:number)=>JSON.stringify(Array.from(crypto.getRandomValues(new Uint8Array(size)))),
        },configurable:true})
        Object.defineProperty(globalThis,Symbol.for('web-container:task-queue'),{value:{
          mode:'approximate-microtask',nextTick:queueMicrotask,
          task:(callback:Function,receiver:unknown,args:unknown[]=[])=>(Reflect.apply(callback,receiver,args)),
        },configurable:true})
        moduleURL=URL.createObjectURL(new Blob([data.code],{type:'text/javascript'}))
        const loaded=await import(/* @vite-ignore */ moduleURL)
        const candidate=loaded.default?.fetch??loaded.fetch??loaded.default
        if(typeof candidate!=='function')throw Error('Native module must export a fetch handler')
        handler=candidate.bind(loaded.default)
        value={loaded:true}
        break
      }
      case 'request': {
        if(!handler)throw Error('Native module not loaded')
        if(!data.url)throw Error('Missing request URL')
        const response=await handler(new IncomingRequest(data.url,{method:data.method??'GET',headers:data.headers,body:data.body}))
        if(!(response instanceof Response))throw Error('Fetch handler did not return a Response')
        value={status:response.status,headers:[...response.headers],body:await response.text()}
        break
      }
      case 'readFile': {
        if(!volume||!data.path)throw Error('Filesystem not loaded or path missing')
        value=new Uint8Array(volume.readFileSync(data.path) as Uint8Array)
        break
      }
      case 'writeFile': {
        if(!volume||!data.path||!data.bytes)throw Error('Filesystem not loaded, path or bytes missing')
        await new VolumeFileSystem(volume).writeFile(data.path,data.bytes,{followSymlinks:false})
        value=null
        break
      }
      case 'snapshot': {
        if(!volume)throw Error('Filesystem not loaded')
        value=Object.fromEntries(Object.keys(volume.toJSON()).filter(path=>volume!.statSync(path).isFile()).map(path=>[path,new Uint8Array(volume!.readFileSync(path) as Uint8Array)]))
        break
      }
      default: throw Error('Unknown native kernel operation')
    }
    self.postMessage({id,ok:true,value})
  }catch(error){
    self.postMessage({id,ok:false,error:error instanceof Error?error.message:String(error)})
  }
}
