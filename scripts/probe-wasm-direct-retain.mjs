import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {build} from 'esbuild'

// Bundle the production TypeScript helper, including parameter properties, in memory.
const helpers=await build({stdin:{contents:`export {retainModuleSource} from './src/sandbox/module-source.ts';export {ModuleMessageBudget,ModuleMessageSender} from './src/sandbox/module-message.ts'`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false})
const {retainModuleSource,ModuleMessageBudget,ModuleMessageSender}=await import('data:text/javascript;base64,'+Buffer.from(helpers.outputFiles[0].contents).toString('base64'))
const root=resolve(process.argv[2]??'public/quickjs-als-asyncify-wasm-atomics-fibers-shared-storage-simd-lazy-wasm')
const metadata=JSON.parse(readFileSync(join(root,'build.json'),'utf8'))
const asynchronous=Boolean(metadata.asyncify)
const core=await import(pathToFileURL(join(root,'core.mjs')).href)
const {default:factory}=await import(pathToFileURL(join(root,'engine.mjs')).href)
const ffi=asynchronous?await import(pathToFileURL(join(root,'ffi.mjs')).href):await (await import('@jitl/quickjs-wasmfile-release-sync')).default.importFFI()
const makeEngine=asynchronous?core.newQuickJSAsyncWASMModuleFromVariant:core.newQuickJSWASMModuleFromVariant
const engine=await makeEngine({type:asynchronous?'async':'sync',importFFI:async()=>asynchronous?ffi.QuickJSAsyncFFI:ffi,importModuleLoader:async()=>()=>factory({wasmBinary:readFileSync(join(root,'engine.wasm'))})})
const leb=value=>{const out=[];do{const byte=value&127;value=Math.floor(value/128);out.push(byte|(value?128:0))}while(value);return out}
const payload=4*1024*1024,header=[0,97,115,109,1,0,0,0,0,...leb(payload)]
const bytes=new Uint8Array(header.length+payload);bytes.set(header) // Empty custom-section name, followed by zero payload.
assert.equal(WebAssembly.validate(bytes),true)
const runtime=engine.newRuntime();runtime.setMemoryLimit(32*1024*1024);runtime.setMaxStackSize(256*1024)
const context=runtime.newContext(),otherRuntime=engine.newRuntime(),other=otherRuntime.newContext()
const budget=new ModuleMessageBudget(8*1024*1024),sender=new ModuleMessageSender(budget)
const evaluate=source=>context.unwrapResult(context.evalCode(source))
let owner
try{
  evaluate('globalThis.__webContainerHost={};'+readFileSync('src/sandbox/guest-wasm.js','utf8')).dispose()
  const input=context.newArrayBuffer(bytes.buffer);context.setProp(context.global,'input',input);input.dispose()
  evaluate('globalThis.module=new WebAssembly.Module(input);new Uint8Array(input).fill(255);globalThis.instance=new WebAssembly.Instance(module);').dispose()
  owner=evaluate('__webContainerHost.wasmModule.handle(module)')
  const usageHandle=runtime.computeMemoryUsage();let usage
  try{usage=context.dump(usageHandle)}finally{usageHandle.dispose()}
  const limit=usage.malloc_size+1024*1024
  assert.ok(Number.isSafeInteger(limit)&&limit<32*1024*1024)
  runtime.setMemoryLimit(limit)
  const copied=context.evalCode('__webContainerHost.wasmModule.bytes(module)')
  assert.ok(copied.error,'Legacy guest ArrayBuffer copy must exceed the intentionally smaller remaining headroom')
  const copyError=context.dump(copied.error);copied.dispose()
  assert.match(String(copyError.message),/memory/i)
  const id=retainModuleSource(context,owner,sender)
  assert.equal(budget.bytes,bytes.length)
  sender.send([id],message=>{try{assert.deepEqual(message.adopt(id),bytes)}finally{message.dispose()}})
  assert.equal(budget.bytes,0)
  evaluate('new WebAssembly.Instance(module)').dispose()
  const wrong=context.newObject()
  try{assert.throws(()=>retainModuleSource(context,wrong,sender),/validated native WASM module/)}finally{wrong.dispose()}
  assert.throws(()=>retainModuleSource(other,owner,sender))
  const disposed=owner.dup();disposed.dispose();assert.throws(()=>retainModuleSource(context,disposed,sender))
  assert.equal(budget.bytes,0)
  console.log(JSON.stringify({engine:root,moduleBytes:bytes.length,initialLimit:32*1024*1024,measuredMalloc:usage.malloc_size,reducedLimit:limit,copyError,directRetain:true,originalMutationPreserved:true,invalidClassRejected:true,crossRuntimeRejected:true,disposedHandleRejected:true,budgetReleased:true}))
}finally{owner?.dispose();sender.dispose();other.dispose();otherRuntime.dispose();context.dispose();runtime.dispose()}
