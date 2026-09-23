import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {transform} from 'esbuild'

test('actual iterative fiber QuickJS pumps nested bundler callbacks in originating ALS',async()=>{
  const root=resolve('public/quickjs-als-asyncify-wasm-o2-atomics-fibers-shared-storage-simd-lazy-wasm-compiled-initializers-iterative-calls-module-import-exports')
  const core=await import(pathToFileURL(join(root,'core.mjs')).href)
  const {default:factory}=await import(pathToFileURL(join(root,'engine.mjs')).href)
  const {QuickJSAsyncFFI}=await import(pathToFileURL(join(root,'ffi.mjs')).href)
  const engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>QuickJSAsyncFFI,importModuleLoader:async()=>async()=>factory({wasmBinary:readFileSync(join(root,'engine.wasm'))})})
  const runtime=engine.newRuntime(),context=runtime.newContext(),pending=new Map(),replies=[]
  runtime.setMemoryLimit(64*1024*1024);runtime.setMaxStackSize(256*1024)
  const deadline=Date.now()+10000;runtime.setInterruptHandler(()=>Date.now()>deadline)
  function expose(name,fn){const handle=context.newFunction(name,fn);context.setProp(context.global,name,handle);handle.dispose()}
  function evaluate(source){context.unwrapResult(context.evalCode(source)).dispose()}
  function drain(){while(runtime.hasPendingJob()){assert.ok(Date.now()<deadline,'Guest job deadline');context.unwrapResult(runtime.executePendingJobs(100))}}
  function settle(key,event){const deferred=pending.get(key);assert.ok(deferred,`Pending ${key}`);pending.delete(key);const value=context.newString(JSON.stringify(event));deferred.resolve(value);value.dispose();deferred.dispose()}
  function deferred(key){assert.ok(!pending.has(key));const value=context.newPromise();pending.set(key,value);return value.handle}
  try{
    expose('__next',()=>deferred('next'))
    expose('__context',()=>deferred('context'))
    expose('__reply',(id,reply)=>{replies.push({id:context.getNumber(id),reply:JSON.parse(context.getString(reply))});return context.undefined})
    expose('__utf8',value=>context.newNumber(Buffer.byteLength(context.getString(value))))
    const source=(await transform(readFileSync('src/compiler/guest-bundler-adapter.js','utf8'),{format:'iife',globalName:'adapter',target:'es2022'})).code
    evaluate(readFileSync('src/sandbox/engine-als-bootstrap.js','utf8')+'\n'+source)
    evaluate(`
      globalThis.TextEncoder=class {encode(value){return {byteLength:__utf8(value)}}};
      globalThis.origin=new __engineAsyncLocalStorage();globalThis.scope=new __engineAsyncLocalStorage();globalThis.seen=[];
      const Binding=adapter.createGuestBundlerAdapter({
        create(){return 1},start(handle,method,options){globalThis.options=options;return 1},
        next(){return __next().then(JSON.parse)},reply(op,id,value){__reply(id,JSON.stringify(value))},
        context(){return __context().then(JSON.parse)},finish(){globalThis.finished=true},cancel(){},reportError(message){throw Error(message)},
      },scope,value=>value,{maxBytes:65536});
      globalThis.bundler=new Binding();
      globalThis.result=origin.run('request-A',()=>bundler.generate({
        first:async ctx=>{seen.push([origin.getStore(),scope.getStore()]);const value=await ctx.resolve('nested');seen.push([origin.getStore(),scope.getStore()]);return value},
        second:async()=>{await Promise.resolve();seen.push([origin.getStore(),scope.getStore()]);return 'resolved'},
      }));
    `)
    drain()
    const optionsHandle=context.getProp(context.global,'options'),options=context.dump(optionsHandle);optionsHandle.dispose()
    evaluate(`origin.enterWith('HOST');scope.enterWith(99)`)
    settle('next',{type:'callback',id:1,callbackId:options.first.id,args:[{type:'native-context',handle:1,scope:10,methods:['resolve']}],scope:10,sync:false})
    drain();assert.ok(pending.has('context'));assert.ok(pending.has('next'),'Nested callbacks must be serviced while parent awaits')
    settle('next',{type:'callback',id:2,callbackId:options.second.id,args:[],scope:20,sync:false});drain()
    assert.deepEqual(replies,[{id:2,reply:{type:'value',value:'resolved'}}])
    settle('context','resolved');drain()
    assert.deepEqual(replies.map(value=>value.id),[2,1])
    settle('next',{type:'result',value:{result:'built',watchFiles:[],closed:false}});drain()
    const promise=context.getProp(context.global,'result'),state=context.getPromiseState(promise)
    assert.equal(state.type,'fulfilled');assert.equal(context.dump(state.value),'built');state.value.dispose();promise.dispose()
    const seen=context.getProp(context.global,'seen');assert.deepEqual(context.dump(seen),[['request-A',10],['request-A',20],['request-A',10]]);seen.dispose()
    assert.equal(pending.size,0)
  }finally{for(const value of pending.values())value.dispose();context.dispose();runtime.dispose()}
})
