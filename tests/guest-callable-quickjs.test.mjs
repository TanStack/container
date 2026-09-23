import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {transform} from 'esbuild'
import {newQuickJSWASMModuleFromVariant,newVariant} from 'quickjs-emscripten-core'
import SYNC from '@jitl/quickjs-wasmfile-release-sync'
import loader from '../public/quickjs-als-o2/engine.mjs'

test('same QuickJS engine dispatches retained callbacks through guest jobs with originating ALS',async()=>{
  const engine=await newQuickJSWASMModuleFromVariant(newVariant({...SYNC,importModuleLoader:async()=>loader},{wasmBinary:readFileSync('public/quickjs-als-o2/engine.wasm')}))
  const runtime=engine.newRuntime(),context=runtime.newContext(),pending=new Map(),replies=[],finished=[]
  runtime.setMemoryLimit(32*1024*1024);runtime.setMaxStackSize(512*1024)
  const deadline=Date.now()+5000;runtime.setInterruptHandler(()=>Date.now()>deadline)
  function expose(name,fn){const handle=context.newFunction(name,fn);context.setProp(context.global,name,handle);handle.dispose()}
  function evaluate(source){const handle=context.unwrapResult(context.evalCode(source));handle.dispose()}
  function drain(){while(runtime.hasPendingJob()){if(Date.now()>deadline)throw Error('Guest callback deadline');context.unwrapResult(runtime.executePendingJobs(100))}}
  function settle(id,event){const deferred=pending.get(id);assert.ok(deferred,'Guest must already be waiting');pending.delete(id);const value=context.newString(JSON.stringify(event));deferred.resolve(value);value.dispose();deferred.dispose()}
  try{
    expose('__next',id=>{const key=context.getNumber(id);assert.ok(!pending.has(key));const deferred=context.newPromise();pending.set(key,deferred);return deferred.handle})
    expose('__reply',(id,value)=>{replies.push([context.getNumber(id),JSON.parse(context.getString(value))]);return context.undefined})
    expose('__finish',id=>{finished.push(context.getNumber(id));return context.undefined})
    const source=(await transform(readFileSync('src/compiler/guest-callable-dispatch.js','utf8'),{format:'iife',globalName:'dispatchModule',target:'es2022'})).code
    evaluate(readFileSync('src/sandbox/engine-als-bootstrap.js','utf8')+'\n'+source)
    evaluate(`
      globalThis.als=new __engineAsyncLocalStorage();globalThis.seen=[];let operation=0;
      globalThis.dispatch=dispatchModule.createGuestCallableDispatch({
        start(){return ++operation},next(id){return __next(id).then(JSON.parse)},
        reply(id,callbackId,value){__reply(id,JSON.stringify({callbackId,value}))},finish:__finish,cancel(){},reportError(message){throw Error(message)},
      });
      const retained=dispatch.register({resolveSubpathImports(value){seen.push([value,als.getStore()]);return value+':'+als.getStore()}});
      const a=als.run('A',()=>dispatch.invoke(retained,'resolveId',['a']));
      const b=als.run('B',()=>dispatch.invoke(retained,'resolveId',['b']));
      globalThis.result=Promise.all([a,b]).then(values=>({values,seen}));
    `)
    drain();assert.equal(pending.size,2)
    evaluate(`als.enterWith('HOST')`)
    settle(2,{type:'callback',id:1,method:'resolveSubpathImports',args:['b']})
    settle(1,{type:'callback',id:1,method:'resolveSubpathImports',args:['a']})
    drain()
    assert.deepEqual(replies,[[2,{callbackId:1,value:{type:'string',value:'b:B'}}],[1,{callbackId:1,value:{type:'string',value:'a:A'}}]])
    settle(1,{type:'result',value:'one'});settle(2,{type:'result',value:'two'});drain()
    const promise=context.getProp(context.global,'result'),state=context.getPromiseState(promise)
    assert.equal(state.type,'fulfilled')
    assert.deepEqual(context.dump(state.value),{values:['one','two'],seen:[['b','B'],['a','A']]})
    state.value.dispose();promise.dispose()
    assert.deepEqual(finished.sort(),[1,2]);assert.equal(pending.size,0)
    evaluate(`globalThis.closedResult=dispatch.invoke(retained,'resolveId',[]).catch(error=>error.message);dispatch.close()`);drain()
    const cancelled=context.getProp(context.global,'closedResult'),cancelledState=context.getPromiseState(cancelled)
    assert.equal(cancelledState.type,'fulfilled');assert.match(context.dump(cancelledState.value),/closed/)
    cancelledState.value.dispose();cancelled.dispose();assert.equal(pending.size,0);assert.deepEqual(finished.sort(),[1,2,3])
  }finally{for(const value of pending.values())value.dispose();context.dispose();runtime.dispose()}
})
