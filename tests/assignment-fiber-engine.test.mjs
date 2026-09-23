import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'

test('combined fiber engine preserves assignment semantics, long chains and parse recovery',async()=>{
  const root=resolve('public/quickjs-als-asyncify-wasm-o2-atomics-assignments-fibers-shared-storage-simd-lazy-wasm-compiled-initializers-iterative-calls-module-import-exports')
  assert.ok(JSON.parse(readFileSync(join(root,'build.json'),'utf8')).assignmentParser)
  // Reuse the existing browser regression's exact oracle expressions.
  const browserTest=readFileSync('tests/install-wasm/assignment-parser.spec.ts','utf8')
  const start=browserTest.indexOf('const cases=['),end=browserTest.indexOf("\ntest('assignment parser",start)
  assert.ok(start>=0&&end>start)
  const cases=new Function(browserTest.slice(start,end)+';return cases')()
  const core=await import(pathToFileURL(join(root,'core.mjs')).href)
  const {default:factory}=await import(pathToFileURL(join(root,'engine.mjs')).href)
  const {QuickJSAsyncFFI}=await import(pathToFileURL(join(root,'ffi.mjs')).href)
  const engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>QuickJSAsyncFFI,importModuleLoader:async()=>async()=>factory({wasmBinary:readFileSync(join(root,'engine.wasm'))})})
  const runtime=engine.newRuntime(),context=runtime.newContext()
  runtime.setMemoryLimit(64*1024*1024);runtime.setMaxStackSize(256*1024)
  const deadline=Date.now()+15000;runtime.setInterruptHandler(()=>Date.now()>deadline)
  function value(source){const result=context.evalCode(source);try{assert.ok(!result.error,result.error?JSON.stringify(context.dump(result.error)):'');return context.dump(result.value)}finally{result.dispose()}}
  try{
    for(const source of cases)assert.equal(value('JSON.stringify((()=>{'+source+'})())'),JSON.stringify(new Function(source)()),source)
    for(const count of [64,128,256,512]){
      const chain=Array.from({length:count},(_,i)=>'o.p'+i).join('=')
      assert.equal(value('(()=>{const o={};'+chain+'=42;return Object.keys(o).length=== '+count+'&&Object.values(o).every(x=>x===42)})()'),true)
      const invalid=context.evalCode('(()=>{const o={};'+chain+'=;})()');assert.ok(invalid.error);invalid.dispose()
      assert.equal(value('6*7'),42)
    }
  }finally{context.dispose();runtime.dispose()}
})
