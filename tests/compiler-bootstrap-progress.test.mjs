import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {addCompilerBootstrapProgress} from '../scripts/compiler-bootstrap-progress.mjs'
import {installCompilerBootstrapReporter,reportCompilerBootstrap,observeCompilerBootstrapWorker} from '../src/native/compiler-bootstrap-progress.mjs'

test('both pinned loaders keep their original await and cleanup boundaries',()=>{
  for(const root of ['node_modules/@rolldown/browser','tests/fixtures/native-runtime-832/node_modules/@rolldown/browser']){
    const source=readFileSync(root+'/dist/rolldown-binding.wasi-browser.js','utf8')
    const result=addCompilerBootstrapProgress(source,'/progress.mjs')
    assert.match(result,/__nativeCompilerBootstrap\("fetching-wasm"\)\nconst __wasmResponse = await globalThis.fetch\(__wasmUrl\)/)
    assert.match(result,/__nativeCompilerBootstrap\("reading-wasm"\)\nconst __wasmFile = await __wasmResponse.arrayBuffer\(\)\n__nativeCompilerBootstrap\("wasm-bytes-ready"\)/)
    const restored=result.replace(/^import \{reportCompilerBootstrap[^\n]+\nlet __nativeCompilerWorkerId=0\n/,'')
      .replace('__nativeCompilerBootstrap("fetching-wasm")\n','')
      .replace('__nativeCompilerBootstrap("reading-wasm")\n','')
      .replace('\n__nativeCompilerBootstrap("wasm-bytes-ready")','')
      .replace('  __nativeCompilerBootstrap("initializing-wasi")\n','')
      .replace('\n  __nativeCompilerBootstrap("binding-ready")','')
      .replace('\n      __observeNativeCompilerWorker(worker, ++__nativeCompilerWorkerId)','')
    // Remove inserted calls without treating changed original statements as metadata.
    assert.equal(restored,source)
  }
})

test('missing, duplicate or already instrumented boundaries fail the build',()=>{
  const source=readFileSync('node_modules/@rolldown/browser/dist/rolldown-binding.wasi-browser.js','utf8')
  for(const anchor of ['const __wasmResponse = await globalThis.fetch(__wasmUrl)',
    'const __wasmFile = await __wasmResponse.arrayBuffer()',
    '  ;({\n    instance: __napiInstance,','      __wasiWorkers.add(worker)',
    '  __publishWasiDispose(__napiModule.exports)']){
    assert.throws(()=>addCompilerBootstrapProgress(source.replace(anchor,''),'/progress.mjs'))
    assert.throws(()=>addCompilerBootstrapProgress(source+'\n'+anchor,'/progress.mjs'))
  }
  assert.throws(()=>addCompilerBootstrapProgress(addCompilerBootstrapProgress(source,'/progress.mjs'),'/progress.mjs'))
})

test('reporter cleanup is idempotent and cannot remove a later reporter',()=>{
  const phases=[],release=installCompilerBootstrapReporter(phase=>phases.push(phase))
  try{
    assert.throws(()=>installCompilerBootstrapReporter(()=>{}),/already installed/)
    reportCompilerBootstrap('fetching-wasm')
  }finally{release()}
  const next=installCompilerBootstrapReporter(phase=>phases.push(phase))
  try{release();reportCompilerBootstrap('binding-ready')}finally{next()}
  reportCompilerBootstrap('ignored')
  assert.deepEqual(phases,['rolldown:fetching-wasm','rolldown:binding-ready'])
})

test('reporter failures do not replace compiler behavior',()=>{
  const release=installCompilerBootstrapReporter(()=>{throw Error('observer failure')})
  try{assert.doesNotThrow(()=>reportCompilerBootstrap('reading-wasm'))}finally{release()}
})

test('worker readiness ignores other messages and removes all observers on load',()=>{
  const phases=[],release=installCompilerBootstrapReporter(phase=>phases.push(phase)),worker=new EventTarget()
  try{
    observeCompilerBootstrapWorker(worker,1)
    const seen=[]
    worker.addEventListener('message',event=>seen.push(event.data))
    const other={__fs__:{payload:'untouched'}},loaded={__emnapi__:{type:'loaded'}}
    worker.dispatchEvent(new MessageEvent('message',{data:other}))
    worker.dispatchEvent(new MessageEvent('message',{data:loaded}))
    worker.dispatchEvent(new MessageEvent('message',{data:loaded}))
    worker.dispatchEvent(new Event('error'))
    assert.deepEqual(seen,[other,loaded,loaded])
    assert.deepEqual(phases,['rolldown:worker-created:1','rolldown:worker-ready:1'])
  }finally{release()}
})

test('worker load failure remains available to its normal handler',()=>{
  for(const event of [new Event('error'),new Event('messageerror'),
    new MessageEvent('message',{data:{__emnapi__:{type:'thread-error',payload:{phase:'load',error:'original'}}}})]){
    const phases=[],release=installCompilerBootstrapReporter(phase=>phases.push(phase)),worker=new EventTarget()
    try{
      observeCompilerBootstrapWorker(worker,2)
      let seen
      worker.addEventListener(event.type,value=>{seen=value})
      worker.dispatchEvent(event)
      assert.equal(seen,event)
      worker.dispatchEvent(new MessageEvent('message',{data:{__emnapi__:{type:'loaded'}}}))
      assert.deepEqual(phases,['rolldown:worker-created:2','rolldown:worker-load-error:2'])
    }finally{release()}
  }
})
