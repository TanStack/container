// Isolated owner-controlled probe, not selected by the kernel or public SDK.
import {instantiateNapiModule,WASI,emnapiAsyncWorkPlugin,emnapiTSFNPlugin,createOnMessage} from '../../tests/fixtures/rolldown-native-probe/node_modules/@napi-rs/wasm-runtime/runtime.js'
import {createContext} from '../../tests/fixtures/rolldown-native-probe/node_modules/@emnapi/runtime/dist/emnapi.js'
import {memfs} from '../../tests/fixtures/rolldown-native-probe/node_modules/@napi-rs/wasm-runtime/dist/fs.js'
import {compile} from '../../tests/fixtures/rolldown-native-probe/compile.mjs'

const scope=globalThis
const children=new Set()
const pending=new Map()
let sequence=0,started=false,created=0,peak=0,fs,binding,closed=false
let queue=Promise.resolve()
const resources=()=>({created,peak,active:children.size,sharedInitialBytes:1073741824,sharedMaximumBytes:1342177280})
// Firefox stacks omit the error message, keep both across the transport.
const describeError=error=>(String(error)+'\n'+String(error?.stack??'')).slice(0,12000)
function close(){
  if(closed)return
  closed=true
  for(const worker of [...children])worker.terminate()
  for(const waiter of pending.values())waiter.reject(Error('Compiler session ended'))
  pending.clear()
}
function callback(method,args){
  if(pending.size>=32)throw Error('Plugin callback queue full')
  return new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});scope.postMessage({type:'callback',id,method,args})})
}
scope.onmessage=async({data})=>{
  if(data.type==='reply'){
    const waiter=pending.get(data.id);if(!waiter)return
    pending.delete(data.id);data.error?waiter.reject(Error(data.error)):waiter.resolve(data.value);return
  }
  if(data.type==='abort'){close();return}
  if(data.type==='command'){
    queue=queue.then(async()=>{
      if(!started||closed||!binding)throw Error('Compiler session is not ready')
      if(data.command==='compile')return {chunks:await compile(binding,callback),resources:resources()}
      if(data.command==='parse'){
        if(typeof data.filename!=='string'||data.filename.length>4096||typeof data.source!=='string'||data.source.length>65536)throw Error('Invalid parser input')
        const options=data.options
        if(options!==undefined&&(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>!['lang','sourceType','preserveParens'].includes(key))||options.lang!==undefined&&!['js','jsx','ts','tsx'].includes(options.lang)||options.sourceType!==undefined&&!['script','module','commonjs','unambiguous'].includes(options.sourceType)||options.preserveParens!==undefined&&typeof options.preserveParens!=='boolean'))throw Error('Invalid parser options')
        const parsed=await binding.parse(data.filename,data.source,options)
        // These are native getters, read them here rather than cloning a NAPI object.
        return {program:parsed.program,module:parsed.module,comments:parsed.comments,errors:parsed.errors}
      }
      if(data.command==='writeFile'){
        if(typeof data.path!=='string'||!/^\/project\/[a-zA-Z0-9_.-]+$/.test(data.path)||typeof data.source!=='string'||data.source.length>65536)throw Error('Invalid workspace update')
        fs.writeFileSync(data.path,data.source);return {written:data.path}
      }
      if(data.command==='close'){close();return {resources:resources()}}
      throw Error('Unsupported compiler command: '+String(data.command))
    }).then(value=>{scope.postMessage({type:'result',id:data.id,value})},error=>{scope.postMessage({type:'result',id:data.id,error:describeError(error)})})
    return
  }
  if(data.type!=='start'||started){scope.postMessage({type:'error',error:'Unsupported compiler transport message'});return}
  started=true
  let result,error
  try{
    if(!scope.crossOriginIsolated||typeof SharedArrayBuffer==='undefined')throw Error('Native Rolldown requires cross-origin isolation and shared memory')
    fs=memfs().fs
    fs.mkdirSync('/project')
    if(!data.files||Object.keys(data.files).length>16)throw Error('Invalid workspace snapshot')
    for(const[path,source]of Object.entries(data.files)){
      if(!/^\/project\/[a-zA-Z0-9_.-]+$/.test(path)||typeof source!=='string'||source.length>65536)throw Error('Invalid workspace snapshot file')
      fs.writeFileSync(path,source)
    }
    // One shared reservation, 1 GiB initial, 1280 MiB maximum, never upstream's 4 GiB.
    const memory=new WebAssembly.Memory({initial:16384,maximum:20480,shared:true})
    const wasi=new WASI({version:'preview1',fs,preopens:{'/':'/'}})
    const context=createContext({autoDestroy:false})
    context.suppressDestroy()
    const response=await fetch(new URL('/compiler.wasm',scope.location.href))
    if(!response.ok)throw Error('Compiler asset unavailable')
    const {napiModule}=await instantiateNapiModule(await response.arrayBuffer(),{
      context,wasi,asyncWorkPoolSize:4,reuseWorker:true,plugins:[emnapiAsyncWorkPlugin,emnapiTSFNPlugin],
      onCreateWorker(){
        if(children.size>=8)throw Error('Native compiler worker ceiling: 8')
        const worker=new Worker(new URL('/pthread.js',scope.location.href),{type:'module'})
        children.add(worker);created++;peak=Math.max(peak,children.size)
        worker.addEventListener('message',createOnMessage(fs))
        const terminate=worker.terminate.bind(worker)
        worker.terminate=()=>{children.delete(worker);terminate()}
        return worker
      },
      overwriteImports(importObject){importObject.env={...importObject.env,...importObject.napi,...importObject.emnapi,memory};return importObject},
      beforeInit({instance}){for(const name of Object.keys(instance.exports))if(name.startsWith('__napi_register__'))instance.exports[name]()},
    })
    binding=napiModule.exports
    scope.postMessage({type:'ready',resources:resources()})
  }catch(cause){close();scope.postMessage({type:'error',error:describeError(cause),resources:resources()})}
}
