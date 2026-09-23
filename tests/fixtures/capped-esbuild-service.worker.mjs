// Node-only positive harness for the unmodified browser service adapter.
// No guest code, filesystem or plugin callbacks execute in this worker.
import {parentPort,workerData} from 'node:worker_threads'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
globalThis.self=globalThis
const esbuild=require('esbuild-wasm/lib/browser.js')
try{
  if(workerData.source.length>65536)throw Error('Harness input limit exceeded')
  if(esbuild.version!=='0.28.2')throw Error('Unexpected compiler version')
  const wasmModule=new WebAssembly.Module(workerData.bytes)
  // worker:false keeps the stock Go service inside this dedicated Node worker.
  // The stock createChannel checks the real binary version handshake.
  await esbuild.initialize({wasmModule,worker:false})
  const result=await esbuild.transform(workerData.source,{loader:'ts',format:'esm',target:'es2022',sourcefile:'ordinary.ts',sourcemap:'external'})
  if(result.code.length+result.map.length>1024*1024)throw Error('Harness output limit exceeded')
  parentPort.postMessage({version:esbuild.version,code:result.code,map:result.map,warnings:result.warnings})
}catch(error){parentPort.postMessage({error:String(error)})}
finally{esbuild.stop();parentPort.close()}
