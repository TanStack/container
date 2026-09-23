import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {transform} from 'esbuild'

test('actual QuickJS distinguishes callback-owned reentry from unrelated pending callable work',async()=>{
  const root=resolve('public/quickjs-als-asyncify-wasm-o2-atomics-fibers-shared-storage-simd-lazy-wasm-compiled-initializers-iterative-calls-module-import-exports')
  const core=await import(pathToFileURL(join(root,'core.mjs')).href)
  const {default:factory}=await import(pathToFileURL(join(root,'engine.mjs')).href)
  const {QuickJSAsyncFFI}=await import(pathToFileURL(join(root,'ffi.mjs')).href)
  const engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>QuickJSAsyncFFI,importModuleLoader:async()=>async()=>factory({wasmBinary:readFileSync(join(root,'engine.wasm'))})})
  const runtime=engine.newRuntime(),context=runtime.newContext(),pending=new Map(),callbacks=new Map(),starts=[],replies=[]
  let sequence=0
  runtime.setMemoryLimit(64*1024*1024);runtime.setMaxStackSize(256*1024)
  const deadline=Date.now()+10000;runtime.setInterruptHandler(()=>Date.now()>deadline)
  const evaluate=source=>context.unwrapResult(context.evalCode(source)).dispose()
  function expose(name,fn){const value=context.newFunction(name,fn);context.setProp(context.global,name,value);value.dispose()}
  function drain(){while(runtime.hasPendingJob()){assert.ok(Date.now()<deadline);context.unwrapResult(runtime.executePendingJobs(100))}}
  function settle(id,event){if(event.type==='callback')callbacks.set(id,event.id);const deferred=pending.get(id);assert.ok(deferred);pending.delete(id);const value=context.newString(JSON.stringify(event));deferred.resolve(value);value.dispose();deferred.dispose()}
  try{
    expose('__start',originHandle=>{
      const origin=JSON.parse(context.getString(originHandle));starts.push(origin)
      if(origin&&callbacks.get(origin.operation)===origin.callback){const error=context.newError('Owned callback reentry');return {error}}
      return context.newNumber(++sequence)
    })
    expose('__next',id=>{const key=context.getNumber(id);assert.ok(!pending.has(key));const deferred=context.newPromise();pending.set(key,deferred);return deferred.handle})
    expose('__reply',(id,reply)=>{const key=context.getNumber(id);callbacks.delete(key);replies.push([key,JSON.parse(context.getString(reply))]);return context.undefined})
    const source=(await transform(readFileSync('src/compiler/guest-callable-dispatch.js','utf8'),{format:'iife',globalName:'module',target:'es2022'})).code
    evaluate(readFileSync('src/sandbox/engine-als-bootstrap.js','utf8')+'\n'+source)
    evaluate(`
      globalThis.origin=new __engineAsyncLocalStorage();globalThis.callbackScope=new __engineAsyncLocalStorage();globalThis.bundlerScope=new __engineAsyncLocalStorage();globalThis.startScopes=[];globalThis.seen=[];
      globalThis.dispatch=module.createGuestCallableDispatch({
        isScoped(){return bundlerScope.getStore()!==undefined},
        start(h,m,a,owner){startScopes.push(bundlerScope.getStore()??null);return __start(JSON.stringify(owner??null))},
        next(id){return __next(id).then(JSON.parse)},reply(id,c,value){__reply(id,JSON.stringify(value))},finish(){},cancel(){},reportError(message){throw Error(message)},
      },callbackScope);
      globalThis.handle=dispatch.register({
        onWarn(){
          seen.push(['warning',origin.getStore()]);
          globalThis.reentry=dispatch.invoke(handle,'resolveId',[]).catch(error=>error.message);
          // Native ignores warning return values. Continuations after its reply
          // carry an expired ownership token and may enqueue ordinary work.
          return Promise.resolve().then(()=>{seen.push(['continued',origin.getStore()]);globalThis.later=dispatch.invoke(handle,'resolveId',[])});
        },
      });
      globalThis.first=origin.run('A',()=>dispatch.invoke(handle,'resolveId',[]));
    `)
    drain()
    // Mark the callback pending natively, then run an unrelated request before
    // its guest continuation, exactly the overlap the old global guard rejected.
    settle(1,{type:'callback',id:7,method:'onWarn',args:[]})
    evaluate(`globalThis.unrelated=origin.run('B',()=>dispatch.invoke(handle,'transform',[]))`)
    drain()
    assert.deepEqual(starts,[null,null,{operation:1,callback:7},{operation:1,callback:7}])
    assert.equal(sequence,3);assert.deepEqual(replies,[[1,{type:'undefined'}]])
    for(const id of [1,2,3])settle(id,{type:'result',value:'done-'+id})
    drain()
    evaluate(`globalThis.result=Promise.all([first,unrelated,later,reentry]).then(values=>({values,seen}))`);drain()
    const promise=context.getProp(context.global,'result'),state=context.getPromiseState(promise)
    assert.equal(state.type,'fulfilled')
    assert.deepEqual(context.dump(state.value),{values:['done-1','done-2','done-3','Owned callback reentry'],seen:[['warning','A'],['continued','A']]})
    state.value.dispose();promise.dispose();assert.equal(pending.size,0)
    evaluate(`
      globalThis.burstSeen=[];
      globalThis.burstHandle=dispatch.register({resolveSubpathImports(value){burstSeen.push([value,origin.getStore()]);return value}});
      globalThis.burst=Promise.all(Array.from({length:130},(_,index)=>origin.run('burst-'+index,()=>dispatch.invoke(burstHandle,'resolveId',[String(index)]))));
    `);drain()
    assert.equal(pending.size,63);assert.equal(sequence,66)
    for(let index=0;index<130;index++){
      const id=4+index
      settle(id,{type:'callback',id:1,method:'resolveSubpathImports',args:[String(index)]});drain()
      settle(id,{type:'result',value:index});drain()
      assert.ok(pending.size<=64)
    }
    const burst=context.getProp(context.global,'burst'),burstState=context.getPromiseState(burst)
    assert.equal(burstState.type,'fulfilled');assert.deepEqual(context.dump(burstState.value),Array.from({length:130},(_,index)=>index))
    const seen=context.getProp(context.global,'burstSeen')
    assert.deepEqual(context.dump(seen),Array.from({length:130},(_,index)=>[String(index),'burst-'+index]))
    seen.dispose();burstState.value.dispose();burst.dispose();assert.equal(pending.size,0)
    const base=sequence
    evaluate(`
      globalThis.startScopes=[];
      globalThis.ordinary=Array.from({length:65},()=>dispatch.invoke(burstHandle,'resolveId',[]));
      globalThis.scopedA=bundlerScope.run('parent-A',()=>dispatch.invoke(burstHandle,'resolveId',[]));
      globalThis.scopedB=bundlerScope.run('parent-B',()=>dispatch.invoke(burstHandle,'resolveId',[]));
      globalThis.mixed=Promise.all([...ordinary,scopedA,scopedB]);
    `);drain()
    assert.equal(pending.size,64);assert.equal(sequence,base+64)
    settle(base+64,{type:'result',value:'A'});drain()
    assert.equal(pending.size,64);assert.equal(sequence,base+65)
    settle(base+65,{type:'result',value:'B'});drain()
    assert.equal(pending.size,63);assert.equal(sequence,base+65)
    for(let index=1;index<=63;index++){settle(base+index,{type:'result',value:index});drain()}
    for(const index of [66,67]){settle(base+index,{type:'result',value:index});drain()}
    const scopes=context.getProp(context.global,'startScopes')
    assert.deepEqual(context.dump(scopes),[...Array(63).fill(null),'parent-A','parent-B',null,null]);scopes.dispose()
    const mixed=context.getProp(context.global,'mixed'),mixedState=context.getPromiseState(mixed)
    assert.equal(mixedState.type,'fulfilled');mixedState.value.dispose();mixed.dispose();assert.equal(pending.size,0)
  }finally{for(const deferred of pending.values())deferred.dispose();context.dispose();runtime.dispose()}
})
