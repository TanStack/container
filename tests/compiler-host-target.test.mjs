import assert from 'node:assert/strict'
import test from 'node:test'
import {build} from 'esbuild'
import {createContext,runInContext} from 'node:vm'
import {readFileSync} from 'node:fs'
import {compilerBrowserHostSource,compilerBrowserHostPlugin} from '../scripts/compiler-host-target.mjs'

const guestProcess=()=>Object.freeze({versions:Object.freeze({node:'24.0.0'}),env:Object.freeze({NODE_ENV:'development'})})
async function compiler({target=true}={}){
  const output=await build({stdin:{contents:`export {ThreadManager,createNapiModule} from '@emnapi/core';
    export const guestVersion=process.versions.node;
    export const shadowedVersion=process=>process.versions.node;
    export {getDefaultContext} from '@emnapi/runtime';`,resolveDir:process.cwd()},
    write:false,bundle:true,platform:'browser',format:'iife',globalName:'compiler',target:'es2022',
    plugins:target?[compilerBrowserHostPlugin()]:[]})
  const processFacade=guestProcess()
  const context=createContext({process:processFacade,console,WebAssembly,SharedArrayBuffer,ArrayBuffer,Uint8Array,Int32Array,
    MessageChannel,WeakRef,FinalizationRegistry,setTimeout,clearTimeout,queueMicrotask})
  runInContext(output.outputFiles[0].text,context)
  return {exports:context.compiler,processFacade,context}
}
class BrowserWorker extends EventTarget{
  messages=[];terminated=0
  postMessage(data){
    this.messages.push(data)
    if(data.__emnapi__?.type==='load')queueMicrotask(()=>this.onmessage?.({data:{__emnapi__:{type:'loaded',payload:{}}}}))
  }
  terminate(){this.terminated++}
}

test('untargeted compiler mistakes the immutable guest facade for its physical Node host',async()=>{
  const {exports}=await compiler({target:false})
  const manager=new exports.ThreadManager({reuseWorker:{size:1,strict:true},onCreateWorker:()=>new BrowserWorker()})
  assert.throws(()=>manager.init(),/worker\.(?:on|once) is not a function/)
})

test('browser compiler pool uses real DOM worker methods without changing the guest process',async()=>{
  const {exports,processFacade,context}=await compiler()
  const workers=[]
  const manager=new exports.ThreadManager({reuseWorker:{size:2,strict:true},onCreateWorker:()=>{
    const worker=new BrowserWorker();workers.push(worker);return worker
  }})
  manager.init();manager.setup(null,null)
  await manager.preloadWorkers()
  assert.equal(workers.length,2);assert.ok(workers.every(worker=>worker.loaded))
  assert.ok(workers.every(worker=>worker.messages[0].__emnapi__.type==='load'))
  manager.shutdownAllWorkers(false)
  assert.ok(workers.every(worker=>worker.terminated===1))
  assert.equal(context.process,processFacade);assert.equal(processFacade.versions.node,'24.0.0')
  assert.ok(Object.isFrozen(processFacade.versions))
  assert.equal(exports.guestVersion,'24.0.0')
  assert.equal(exports.shadowedVersion({versions:{node:'18.0.0'}}),'18.0.0')
})

test('the NAPI send listener selects DOM events under the unchanged guest facade',async()=>{
  const {exports,processFacade}=await compiler()
  const module=exports.createNapiModule({context:exports.getDefaultContext(),asyncWorkPoolSize:0})
  const worker=new BrowserWorker()
  assert.equal(module.emnapi.addSendListener(worker),true)
  assert.ok(worker._emnapiSendListener)
  worker._emnapiSendListener.dispose()
  assert.equal(worker._emnapiSendListener,undefined)
  assert.equal(processFacade.versions.node,'24.0.0')
})

test('only version-matched compiler host entries are eligible',async()=>{
  const source=readFileSync('node_modules/@emnapi/wasi-threads/dist/wasi-threads.js','utf8')
  assert.equal(await compilerBrowserHostSource(source,{name:'guest-library',version:'2.1.0',file:'wasi-threads.js'}),undefined)
  for(const identity of [{name:'@emnapi/wasi-threads',version:'2.2.0',file:'wasi-threads.js'},
    {name:'@emnapi/wasi-threads',version:'2.1.0',file:'other.js'}])
    await assert.rejects(compilerBrowserHostSource(source,identity),/Unverified compiler host/)
})

test('classifier drift, duplicates and already targeted source fail the build',async()=>{
  const source=readFileSync('node_modules/@emnapi/wasi-threads/dist/wasi-threads.js','utf8')
  const identity={name:'@emnapi/wasi-threads',version:'2.1.0',file:'wasi-threads.js'}
  const result=await compilerBrowserHostSource(source,identity)
  for(const invalid of [source.replace("typeof process.versions.node === 'string'","hostIsNode()"),source+'\n'+source,result])
    await assert.rejects(compilerBrowserHostSource(invalid,identity),/classifier changed/)
})

test('the old compiler entries use the same guarded browser host target',async()=>{
  const source="var ENVIRONMENT_IS_NODE = typeof process === 'object' && process !== null && typeof process.versions === 'object' && process.versions !== null && typeof process.versions.node === 'string'; export {ENVIRONMENT_IS_NODE};"
  for(const identity of [{name:'@emnapi/core',version:'1.11.1',file:'emnapi-core.esm-bundler.js'},
    {name:'@emnapi/wasi-threads',version:'1.2.2',file:'wasi-threads.esm-bundler.js'}]){
    const result=await compilerBrowserHostSource(source,identity)
    const context=createContext({process:guestProcess()})
    runInContext(result.replace('export {','globalThis.result={'),context)
    assert.equal(context.result.ENVIRONMENT_IS_NODE,false)
    assert.equal(context.process.versions.node,'24.0.0')
  }
})
