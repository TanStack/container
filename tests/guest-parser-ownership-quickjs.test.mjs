import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createGuestParserAdapter} from '../src/compiler/guest-parser-adapter.js'

test('QuickJS parser adapter carries causal ownership across guest jobs without contaminating independent work',async()=>{
  const root=resolve('public/quickjs-als-asyncify-wasm-o2-atomics-fibers-shared-storage-simd-lazy-wasm-compiled-initializers-iterative-calls-module-import-exports')
  const core=await import(pathToFileURL(join(root,'core.mjs')).href)
  const {default:factory}=await import(pathToFileURL(join(root,'engine.mjs')).href)
  const {QuickJSAsyncFFI}=await import(pathToFileURL(join(root,'ffi.mjs')).href)
  const engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>QuickJSAsyncFFI,importModuleLoader:async()=>async()=>factory({wasmBinary:readFileSync(join(root,'engine.wasm'))})})
  const runtime=engine.newRuntime(),context=runtime.newContext(),seen=[]
  const evaluate=source=>context.unwrapResult(context.evalCode(source)).dispose()
  const deadline=Date.now()+10000;runtime.setInterruptHandler(()=>Date.now()>deadline)
  try{
    const host=context.newFunction('host',(_file,_source,_options,operation,callback)=>{
      const origin=[context.dump(operation),context.dump(callback)];seen.push(origin)
      if(origin[0]===7&&origin[1]===3)return {error:context.newError('Owned pending callback')}
      const deferred=context.newPromise(),value=context.newString('{"ok":true}')
      deferred.resolve(value);value.dispose();const result=deferred.handle.dup();deferred.dispose();return result
    })
    context.setProp(context.global,'host',host);host.dispose()
    evaluate(readFileSync('src/sandbox/engine-als-bootstrap.js','utf8'))
    evaluate(`globalThis.scope=new __engineAsyncLocalStorage();globalThis.parse=(${createGuestParserAdapter.toString()})(host,scope);globalThis.results=[];
      scope.run({operation:7,callback:3},()=>Promise.resolve().then(()=>parse('owned','1')).catch(error=>results.push(error.message)));
      Promise.resolve().then(()=>parse('independent','2')).then(value=>results.push(value.ok));
      scope.run({operation:7,callback:2},()=>parse('expired','3')).then(value=>results.push(value.ok));`)
    while(runtime.hasPendingJob()){assert.ok(Date.now()<deadline);context.unwrapResult(runtime.executePendingJobs(100))}
    assert.deepEqual(seen,[[7,2],[7,3],[undefined,undefined]])
    const result=context.getProp(context.global,'results');try{assert.deepEqual(context.dump(result).sort(),['Owned pending callback',true,true].sort())}finally{result.dispose()}
  }finally{context.dispose();runtime.dispose()}
})
