import rollupWasmBytes from '@rollup/wasm-node/dist/wasm-node/bindings_wasm_bg.wasm'
import {Buffer} from 'buffer'
import {EventEmitter} from 'events'
import process from 'process/browser'
import {networkCall} from '../sandbox/virtual-network'
import {network} from './runtime-network'
export {network,virtualListeningPorts,connectVirtual} from './runtime-network'
import {nodeCompatibilityVersion,sandboxVersion} from '../sandbox/runtime-profile'
import {installBufferBase64Url} from './node-buffer'
import {reportNativeNetworkFailure} from '../native/network-failure-diagnostics'

const globals=globalThis as unknown as {
  Buffer:typeof Buffer
  process:typeof process
  global:typeof globalThis
  __rollupWasmBytes:Uint8Array
}
globals.Buffer=Buffer
globals.process=process
globals.global=globalThis
globals.__rollupWasmBytes=rollupWasmBytes

Object.defineProperty(globalThis,'__webContainerHost',{value:{
  net:{
    call:(method:string,...args:unknown[])=>networkCall(network,1,method,args),
    next:(id:number)=>network.next(1,id),
    write:(id:number,bytes:Uint8Array)=>network.write(1,id,bytes),
  },
  reportError:(error:unknown)=>reportNativeNetworkFailure(error,()=>network.snapshot()),
},configurable:true})
Object.defineProperty(globalThis,Symbol.for('web-container:task-queue'),{value:{
  mode:'approximate-microtask',nextTick:queueMicrotask,
  task:(callback:Function,receiver:unknown,args:unknown[]=[])=>(Reflect.apply(callback,receiver,args)),
},configurable:true})
installBufferBase64Url()
process.cwd=()=>'/app'
process.chdir=()=>{}
process.env.NODE_ENV='production'
process.versions.node=nodeCompatibilityVersion
process.versions.tanstackSandbox=sandboxVersion
process.version='v'+nodeCompatibilityVersion
// This runtime has no Node executable flags. Guest script arguments belong to argv.
Object.assign(process,{execArgv:[]})
Object.assign(process,{memoryUsage:()=>{
  if(process.env.NATIVE_MODULE_TRACE==='1')globalThis.postMessage({type:'native-dev-progress',phase:'process-memory-usage-unsupported'})
  throw Object.assign(new Error('Guest heap memory measurement is unavailable in this browser runtime'),{code:'ERR_UNSUPPORTED_OPERATION'})
}})
;(process as typeof process&{pid:number}).pid=(crypto.getRandomValues(new Uint32Array(1))[0]!&0x7fffffff)||1
const outputStream={isTTY:false,columns:80,getColorDepth:()=>1}
;(process as typeof process&{stdout:typeof outputStream;stderr:typeof outputStream}).stdout=outputStream
;(process as typeof process&{stdout:typeof outputStream;stderr:typeof outputStream}).stderr=outputStream
;(process as typeof process&{stdin:EventEmitter}).stdin=new EventEmitter()
