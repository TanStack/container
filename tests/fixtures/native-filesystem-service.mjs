import assert from 'node:assert/strict'
import {once} from 'node:events'
import {Worker} from 'node:worker_threads'
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {fs as constructors} from 'memfs'
import {replaceWasiFsProxy} from '../../scripts/wasi-fs-proxy-transport.mjs'
import {createWasiFilesystemClient} from '../../src/native/wasi-fs-transport.mjs'
import {createWasiFilesystemEndpoint} from '../../src/native/wasi-filesystem-service.mjs'

const require=createRequire(import.meta.url),runtime=dirname(require.resolve('@napi-rs/wasm-runtime'))
assert.equal(JSON.parse(readFileSync(join(runtime,'package.json'))).version,'1.2.4')
const source=replaceWasiFsProxy(readFileSync(join(runtime,'fs-proxy.js'),'utf8'),
  new URL('../../src/native/wasi-fs-transport.mjs',import.meta.url).href)+'\nexport {decodeValue};'
const codecURL='data:text/javascript;base64,'+Buffer.from(source).toString('base64'),codec=await import(codecURL)

export async function withNativeFilesystemService(fn,{codecVersion='1.2.4'}={}){
  let selectedCodecURL=codecURL,selectedCodec=codec
  if(codecVersion!=='1.2.4'){
    const {loadFilesystemCodecs}=await import('./wasi-filesystem-codecs.mjs')
    const input=loadFilesystemCodecs()[codecVersion]
    assert.ok(input,'Unknown filesystem control codec')
    selectedCodecURL=input.url;selectedCodec=await import(input.url)
  }
  const worker=new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{
      const {createNativeFilesystemBackend}=await import(workerData.backendURL),{fs}=createNativeFilesystemBackend();
      const {createWasiFilesystemService}=await import(workerData.serviceURL),codec=await import(workerData.codecURL);
      fs.mkdirSync('/app',{recursive:true});
      const service=createWasiFilesystemService(fs,codec.createOnMessage);
      parentPort.on('message',data=>{
        if(data.type==='inspect')parentPort.postMessage({type:'inspect',...service.inspect(),...service.inspectWatchers(),...service.inspectDirectories()});
        else if(data.type==='releaseScope'){service.releaseScope(data.prefix);parentPort.postMessage({type:'released'});}
        else service.onMessage({data});
      });
      parentPort.postMessage({type:'ready'});
    })().catch(error=>{throw error});
  `,{eval:true,workerData:{codecURL:selectedCodecURL,
    backendURL:new URL('../../src/native/filesystem-backend.mjs',import.meta.url).href,
    serviceURL:new URL('../../src/native/wasi-filesystem-service.mjs',import.meta.url).href}})
  const endpoints=[]
  try{
    assert.deepEqual((await once(worker,'message',{signal:AbortSignal.timeout(5000)}))[0],{type:'ready'})
    const connect=id=>{
      const endpoint=createWasiFilesystemEndpoint(worker,id);endpoints.push(endpoint)
      const rpc=createWasiFilesystemClient(constructors,{decodeValue:selectedCodec.decodeValue,timeoutMs:3000,
        send:message=>endpoint.port.postMessage(message)})
      const fs=new Proxy(rpc,{get(target,key){return key==='constants'?constructors.constants:Reflect.get(target,key)}})
      return {fs,endpoint}
    }
    const inspect=async()=>{
      const reply=once(worker,'message',{signal:AbortSignal.timeout(3000)})
      worker.postMessage({type:'inspect'});return (await reply)[0]
    }
    const releaseScope=async prefix=>{
      const reply=once(worker,'message',{signal:AbortSignal.timeout(3000)})
      worker.postMessage({type:'releaseScope',prefix});return (await reply)[0]
    }
    await fn({connect,inspect,releaseScope})
  }finally{
    for(const endpoint of endpoints)endpoint.dispose()
    await worker.terminate()
  }
}
