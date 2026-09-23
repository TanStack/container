import {test} from 'node:test'
import assert from 'node:assert/strict'
import {snapshotBindingResult,encodeBindingSnapshot,restoreGuestBindingResult} from '../src/compiler/rolldown-binding-output.js'
import {u as transformToRollupOutput} from './fixtures/rolldown-native-probe/node_modules/rolldown/dist/shared/bindingify-input-options-D4l624og.mjs'
import {t as requireBinding} from './fixtures/rolldown-native-probe/node_modules/rolldown/dist/shared/binding-BbrDfv1x.mjs'
import {t as createBundlerOptions} from './fixtures/rolldown-native-probe/node_modules/rolldown/dist/shared/create-bundler-option-DJpvtSqr.mjs'

function nativeOutput(){
  const methods=values=>Object.fromEntries(Object.entries(values).map(([name,value])=>[name,()=>value]))
  return {chunks:[methods({getFileName:'entry.js',getName:'entry',getExports:['answer'],getIsEntry:true,getFacadeModuleId:'/entry.js',getIsDynamicEntry:false,getSourcemapFileName:undefined,getPreliminaryFileName:'entry.js',getCode:'export const answer = 42;',getModules:{keys:['/entry.js'],values:[{code:'const answer = 42;',renderedExports:['answer']}]},getImports:[],getDynamicImports:[],getModuleIds:['/entry.js'],getMap:undefined})],assets:[methods({getFileName:'binary.bin',getOriginalFileName:undefined,getOriginalFileNames:[],getSource:{inner:new Uint8Array([0,127,128,255])},getName:undefined,getNames:[]})],mangleCache:undefined}
}
const roundTrip=value=>restoreGuestBindingResult(JSON.parse(JSON.stringify(structuredClone(encodeBindingSnapshot(snapshotBindingResult(value))))))

test('actual pinned native bundler output survives transport into its unchanged wrapper',async()=>{
  const binding=requireBinding(),bundle=new binding.BindingBundler()
  binding.startAsyncRuntime()
  try{
    const prepared=await createBundlerOptions({input:'owned-entry',plugins:[{
      name:'owned-output-transport',resolveId(id){if(id==='owned-entry')return '\0owned-entry'},
      load(id){if(id==='\0owned-entry')return 'export const answer=42'},
      buildStart(){this.emitFile({type:'asset',fileName:'owned.bin',source:new Uint8Array([0,127,128,255])})},
    }]},{format:'esm',sourcemap:'hidden'},false)
    const native=await bundle.generate(prepared.bundlerOptions)
    const restored=roundTrip(native)
    const expected=transformToRollupOutput(native).output,actual=transformToRollupOutput(restored).output
    const materialize=item=>JSON.parse(JSON.stringify(item,function(key,value){return ArrayBuffer.isView(this[key])?Array.from(this[key]):value}))
    assert.deepEqual(actual.map(materialize),expected.map(materialize))
    assert.ok(actual.find(item=>item.type==='chunk').code.includes('42'))
    assert.deepEqual(actual.find(item=>item.fileName==='owned.bin').source,new Uint8Array([0,127,128,255]))
  }finally{await bundle.close();binding.shutdownAsyncRuntime()}
})

test('installed Rolldown wrapper reads transported chunks and binary assets',()=>{
  const output=transformToRollupOutput(roundTrip(nativeOutput())).output
  assert.equal(output[0].code,'export const answer = 42;')
  assert.equal(output[0].fileName,'entry.js')
  assert.equal(output[0].isEntry,true)
  assert.deepEqual(output[0].exports,['answer'])
  assert.equal(output[0].modules['/entry.js'].renderedLength,18)
  assert.equal(output[0].map,null)
  assert.equal(output[0].sourcemapFileName,null)
  assert.deepEqual(output[1].source,new Uint8Array([0,127,128,255]))
  assert.equal(output[1].name,undefined)
})

test('release behavior matches native binding and keepDataAlive wrapper caches fields',()=>{
  const raw=roundTrip(nativeOutput())
  assert.deepEqual(raw.chunks[0].dropInner(),{freed:true})
  assert.deepEqual(raw.chunks[0].dropInner(),{freed:false,reason:'Memory has already been freed'})
  assert.throws(()=>raw.chunks[0].getCode(),{code:'GenericFailure',message:'Memory has been freed by `freeExternalMemory()`. Cannot access properties. To prevent this, use `freeExternalMemory(handle, true)` with `keepDataAlive`.'})
  const output=transformToRollupOutput(roundTrip(nativeOutput())).output
  assert.deepEqual(output[0].__rolldown_external_memory_handle__(true),{freed:true})
  assert.equal(output[0].code,'export const answer = 42;')
  assert.deepEqual(output[1].__rolldown_external_memory_handle__(true),{freed:true})
  assert.deepEqual(output[1].source,new Uint8Array([0,127,128,255]))
})

test('error envelopes retain native fields and actual Error values',()=>{
  const error=Object.assign(new TypeError('plugin failed',{cause:new Error('inner')}),{plugin:'fixture',id:'/entry.js'})
  const result=roundTrip({isBindingErrors:true,errors:[{type:'JsError',field0:error},{type:'NativeError',field0:{kind:'PARSE_ERROR',message:'invalid',id:'/entry.js',loc:{line:1,column:2,file:'/entry.js'},pos:2}}]})
  assert.ok(result.errors[0].field0 instanceof Error)
  assert.equal(result.errors[0].field0.name,'TypeError')
  assert.equal(result.errors[0].field0.plugin,'fixture')
  assert.equal(result.errors[0].field0.cause.message,'inner')
  assert.equal(result.errors[1].field0.loc.column,2)
})

test('actual plugin error metadata survives the worker and guest transports',async()=>{
  const binding=requireBinding(),bundle=new binding.BindingBundler()
  binding.startAsyncRuntime()
  try{
    const prepared=await createBundlerOptions({input:'owned-error',plugins:[{
      name:'owned-output-error',resolveId(id){return id},
      load(){throw Object.assign(new Error('owned failure'),{code:'OWNED_FAILURE'})},
    }]},{format:'esm'},false)
    const output=roundTrip(await bundle.generate(prepared.bundlerOptions))
    assert.equal(output.isBindingErrors,true)
    const error=output.errors[0].field0
    assert.ok(error instanceof Error)
    assert.equal(error.message,'owned failure')
    assert.equal(error.code,'PLUGIN_ERROR')
    assert.equal(error.pluginCode,'OWNED_FAILURE')
    assert.equal(error.plugin,'owned-output-error')
    assert.equal(error.hook,'load')
  }finally{await bundle.close();binding.shutdownAsyncRuntime()}
})

test('transport rejects unsupported native values, cycles and excessive output',()=>{
  assert.throws(()=>encodeBindingSnapshot({fn(){}}),/Unsupported/)
  const cyclic={};cyclic.self=cyclic
  assert.throws(()=>encodeBindingSnapshot(cyclic),/Cyclic/)
  assert.throws(()=>encodeBindingSnapshot({source:'x'.repeat(100)},32),/byte limit/)
  assert.throws(()=>encodeBindingSnapshot(new Map()),/Unsupported native/)
})

test('guest restore is closure-free and object keys cannot change prototypes',()=>{
  const restore=(0,eval)('('+restoreGuestBindingResult.toString()+')')
  const result=nativeOutput();result.mangleCache=JSON.parse('{"__proto__":{"polluted":true}}')
  const decoded=restore(encodeBindingSnapshot(snapshotBindingResult(result)))
  assert.equal(Object.getPrototypeOf(decoded.mangleCache),Object.prototype)
  assert.equal(decoded.mangleCache.__proto__.polluted,true)
  assert.equal({}.polluted,undefined)
  assert.equal(decoded.chunks[0].getCode(),'export const answer = 42;')
})
