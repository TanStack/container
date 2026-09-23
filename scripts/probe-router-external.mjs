import {readFileSync,realpathSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL,fileURLToPath} from 'node:url'
import assert from 'node:assert/strict'

// Run with --experimental-import-meta-resolve so Node supplies the reference
// package resolver. This reads an existing owned installation without rewriting it.
const project=realpathSync(process.argv[2])
const root=resolve(process.argv[3]??'public/quickjs-als-asyncify-wasm-o2-atomics-fibers-shared-storage-simd-lazy-wasm-compiled-initializers-iterative-calls')
const core=await import(pathToFileURL(join(root,'core.mjs')).href)
const {default:factory}=await import(pathToFileURL(join(root,'engine.mjs')).href)
const {QuickJSAsyncFFI}=await import(pathToFileURL(join(root,'ffi.mjs')).href)
const engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>QuickJSAsyncFFI,importModuleLoader:async()=>async()=>factory({wasmBinary:readFileSync(join(root,'engine.wasm'))})})
const runtime=engine.newRuntime(),context=runtime.newContext()
runtime.setMemoryLimit(64*1024*1024);runtime.setMaxStackSize(256*1024)
const deadline=Date.now()+15000;runtime.setInterruptHandler(()=>Date.now()>deadline)
const loaded=[]
const handles=[]
const guestHooks=process.argv.includes('--guest-hooks')
const callRouter=process.argv.includes('--call')
if(guestHooks){
  const expose=(name,callback)=>{const fn=context.newFunction(name,callback);context.setProp(context.global,name,fn);fn.dispose()}
  expose('__resolve',(specifier,parent)=>{
    const id=import.meta.resolve(context.getString(specifier),context.getString(parent))
    return context.newString(JSON.stringify({id,path:fileURLToPath(id),kind:'module'}))
  })
  expose('__load',id=>context.newString(JSON.stringify({format:'module',source:readFileSync(fileURLToPath(context.getString(id)),'utf8')})))
  context.unwrapResult(context.evalCode(readFileSync('src/sandbox/guest-module-hooks.js','utf8')+'\nglobalThis.hooks=createModuleHooks(__resolve,url=>JSON.parse(__load(url)))')).dispose()
  const resolveHook=context.unwrapResult(context.evalCode('(specifier,parent)=>hooks.resolve(specifier,parent,"import")'))
  const loadHook=context.unwrapResult(context.evalCode('(id)=>hooks.load(id).source'))
  handles.push(resolveHook,loadHook)
  const invoke=(fn,values)=>{
    const args=values.map(value=>context.newString(value))
    try{const result=context.unwrapResult(context.callFunction(fn,context.undefined,...args));try{return context.getString(result)}finally{result.dispose()}}
    finally{args.forEach(arg=>arg.dispose())}
  }
  runtime.setModuleLoader(id=>{loaded.push(id);return `import.meta.url=${JSON.stringify(id)};\n`+invoke(loadHook,[id])},(base,id)=>JSON.parse(invoke(resolveHook,[id,base])).id)
}else runtime.setModuleLoader(id=>{loaded.push(id);return readFileSync(fileURLToPath(id),'utf8')},(base,id)=>import.meta.resolve(id,base))
try{
  context.unwrapResult(context.evalCode('globalThis.process={env:{NODE_ENV:"development"}}')).dispose()
  const entry=pathToFileURL(join(project,'probe.mjs')).href
  let source=`import {RouterCore} from '@tanstack/router-core';import * as server from '@tanstack/router-core/isServer';globalThis.result={keys:Object.keys(server),type:typeof server.loadServerRoute,isServer:server.isServer,router:typeof RouterCore};`
  let nativeResult
  if(callRouter){
    context.unwrapResult(context.evalCode(readFileSync('public/vm-web-apis/globals.js','utf8'),'web-apis.js')).dispose()
    const coreURL=import.meta.resolve('@tanstack/router-core',entry),historyURL=import.meta.resolve('@tanstack/history',entry)
    source=`import {RouterCore,BaseRootRoute,createNonReactiveMutableStore,createNonReactiveReadonlyStore} from ${JSON.stringify(coreURL)};
import {createMemoryHistory} from ${JSON.stringify(historyURL)};
const routeTree=new BaseRootRoute({loader:()=>42});
const router=new RouterCore({routeTree,history:createMemoryHistory({initialEntries:['/']}),isServer:true},()=>({createMutableStore:createNonReactiveMutableStore,createReadonlyStore:createNonReactiveReadonlyStore,batch:fn=>fn()}));
globalThis.resultPromise=router.load().then(()=>({status:router.state.status,matches:router.state.matches.map(match=>({id:match.id,status:match.status,loaderData:match.loaderData}))}),error=>({error:{message:error.message,stack:error.stack}}));`
    await import('data:text/javascript,'+encodeURIComponent(source))
    nativeResult=await globalThis.resultPromise
    console.log(JSON.stringify({native:nativeResult}))
  }
  const result=context.evalCode(source,entry,{type:'module'})
  if(result.error)throw context.dump(result.error)
  result.dispose()
  while(runtime.hasPendingJob())context.unwrapResult(runtime.executePendingJobs(100))
  const answer=context.getProp(context.global,callRouter?'resultPromise':'result')
  try{
    if(callRouter){const state=context.getPromiseState(answer);try{const actual=state.type==='fulfilled'?context.dump(state.value):state;console.log(JSON.stringify({root,answer:actual,loaded}));assert.deepEqual(actual,nativeResult)}finally{state.value?.dispose()}}
    else console.log(JSON.stringify({root,answer:context.dump(answer),loaded}))
  }finally{answer.dispose()}
}finally{handles.forEach(handle=>handle.dispose());context.dispose();runtime.dispose()}
