import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, mkdirSync, writeFileSync, symlinkSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {sdkEngineDirectories, inspectSDKBuildProfile, inspectSDKEngine} from '../scripts/sdk-build-profiles.mjs'

const candidate = 'cooperative-o2-heap-loops-batch16'
const desktopAlpha = 'experimental-fibers-simd-lazy-initializers-o2-iterative-calls-module-import-exports-assignments-cooperative-heap-loops'
const segmentedInterpreter = desktopAlpha+'-segmented-interpreter'
const batchedInterpreter = segmentedInterpreter+'-batched'
const nativeUTF8 = batchedInterpreter+'-native-utf8'
const nativeUTF8Buffer = nativeUTF8+'-buffer'
const guestSampling = nativeUTF8+'-guest-sampling'
function fixture(profile = 'default', change = () => {}) {
  const selectedProfile=profile
  if([segmentedInterpreter,batchedInterpreter,nativeUTF8,nativeUTF8Buffer,guestSampling].includes(profile))profile=desktopAlpha
  const root = mkdtempSync(join(tmpdir(), 'sdk-profile-test-'))
  for (const [slot, source] of Object.entries(sdkEngineDirectories(selectedProfile))) {
    const directory = join(root, source); mkdirSync(directory)
    const bytes = Buffer.from(slot)
    const metadata = {wasmSha256: createHash('sha256').update(bytes).digest('hex'), wasmBytes: bytes.length,
      asyncify: slot.includes('asyncify'), optimization: profile === candidate || (profile===desktopAlpha&&slot.includes('cooperative')) || (profile === 'sync-o2' && !slot.includes('asyncify')) ? 'O2' : 'Oz',
      ...(slot.includes('-wasm') ? {guestWasm: {dispatchBatch: 16, dispatchUnwind: true, heapLoops: true}} : {}),
      generatorQueue: {stageSHA256: 'fixture'}, assignmentParser: {stageSHA256: 'fixture'},
      cooperative: {profileYields: true, wasmPoll: 4096},
      requireESM:{stageSHA256:'a'.repeat(64),bindingSHA256:'b'.repeat(64)},
      ...(slot.includes('-fibers')?{atomics:true,fibers:{bindingSHA256:'1'.repeat(64),buildStageSHA256:'2'.repeat(64),stackBytes:524288,quickJSStackBytes:393216,nativeHeadroomBytes:131072,scope:'experimental scheduler-owned QTS_Call and QTS_Eval continuations, not WASM threads'},sharedStorage:{bindingSHA256:'3'.repeat(64),atomicWaitStageSHA256:'4'.repeat(64),buildStageSHA256:'2'.repeat(64),maxBytes:16777216,maxAllocations:256,scope:slot.includes('-wasm')?'group-owned SAB and WASM memory, message leases and single-engine scheduler-owned atomic operations':'engine-owned fixed SAB storage, message leases and native scheduler-owned atomic waits; not shared WASM'}}:{}),
    }
    if(['experimental-fibers-simd','experimental-fibers-simd-lazy','experimental-fibers-simd-lazy-fairness'].includes(profile)&&slot.includes('-wasm-atomics-fibers'))metadata.guestWasm.simd={experimental:true,foundationSHA256:'a'.repeat(64),operationsSHA256:'b'.repeat(64)}
    if(['experimental-fibers-simd-lazy','experimental-fibers-simd-lazy-fairness'].includes(profile)&&slot.includes('-wasm-atomics-fibers'))metadata.guestWasm.lazyCompilation={experimental:true,validation:'eager',stageSHA256:'c'.repeat(64)}
    if(profile==='experimental-fibers-simd-lazy-fairness'&&slot.includes('-fibers'))metadata.fibers.fairness={experimental:true,status:3,stageSHA256:'d'.repeat(64),wasmGuard:slot.includes('-wasm'),scope:slot.includes('-wasm')?'JavaScript bytecode branch polls only, outside native WASM operations and imported callbacks':'JavaScript bytecode branch polls only'}
    if(['experimental-fibers-simd-lazy-initializers','experimental-fibers-simd-lazy-initializers-o2','experimental-fibers-simd-lazy-initializers-o2-assignments','experimental-fibers-simd-lazy-initializers-o2-iterative-calls','experimental-fibers-simd-lazy-initializers-o2-iterative-calls-module-import-exports','experimental-fibers-simd-lazy-initializers-o2-iterative-calls-module-import-exports-assignments',desktopAlpha].includes(profile)&&slot.includes('-wasm-atomics-fibers')){
      if(profile.includes('-o2'))metadata.optimization='O2'
      if(profile.endsWith('-assignments')||profile===desktopAlpha)metadata.assignmentParser={stageSHA256:'f'.repeat(64)}
      metadata.guestWasm.simd={experimental:true,foundationSHA256:'a'.repeat(64),operationsSHA256:'b'.repeat(64)}
      metadata.guestWasm.lazyCompilation={experimental:true,validation:'eager',stageSHA256:'c'.repeat(64)}
      metadata.compiledInitializers={bindingSHA256:'e'.repeat(64),maxSourceBytes:2097152,maxCompiledBytes:8388608,scope:'Host-only same-engine initialization, no guest bytecode API'}
      if(profile.includes('-iterative-calls')){metadata.interpreterFrames={limit:4096,stageSHA256:'f'.repeat(64)};metadata.guestCallDepth={limit:192,nativeReentryLimit:64}}
      if(profile.includes('-module-import-exports'))metadata.moduleImportExports={stageSHA256:'d'.repeat(64)}
    }
    if([segmentedInterpreter,batchedInterpreter,nativeUTF8,nativeUTF8Buffer,guestSampling].includes(selectedProfile)&&slot==='quickjs-als-asyncify-wasm-atomics-fibers-shared-storage'){
      metadata.interpreterMachine={stageSHA256:'a'.repeat(64),scope:'ordinary opcode families with coordinator-owned entry, calls, yields and unwind'}
      metadata.binaryenOneCallerInlineMax=50
      metadata.noInline=false
      if([batchedInterpreter,nativeUTF8,nativeUTF8Buffer,guestSampling].includes(selectedProfile))Object.assign(metadata.interpreterMachine,{variant:'persistent-state-family-runs',baseStageSHA256:'b'.repeat(64)})
      if([nativeUTF8,nativeUTF8Buffer,guestSampling].includes(selectedProfile))metadata.nativeUTF8={stageSHA256:'c'.repeat(64),bindingSHA256:'d'.repeat(64),intrinsic:'__qjsEncodeUTF8',operations:['encodeUTF8'],input:'string',output:'ArrayBuffer',allocation:'QuickJS runtime allocator, fresh guest-owned bytes',loneSurrogates:'U+FFFD',interruptPollCodeUnits:65536,maxOutputBytes:2147483647}
      if(selectedProfile===guestSampling)metadata.guestSampling={experimental:true,maxSamples:512,intervalMs:20,functionBytes:96,filenameBytes:192,retention:'latest512',storage:'runtime-owned host allocation outside guest heap quota',maxStorageBytes:172064,stageSHA256:'e'.repeat(64),bindingSHA256:'f'.repeat(64)}
      if(selectedProfile===nativeUTF8Buffer)metadata.nativeUTF8Buffer={experimental:true,stageSHA256:'e'.repeat(64),bindingSHA256:'f'.repeat(64),intrinsics:['__qjsUTF8ByteLength','__qjsWriteUTF8'],operations:['utf8ByteLength','writeUTF8'],input:'string',target:'Uint8Array',ranges:'strict view-relative integer offset and limit',loneSurrogates:'U+FFFD',partialCodePoints:false,interruptPollCodeUnits:65536,encodedOutputAllocation:false}
    }
    change(metadata, slot)
    writeFileSync(join(directory, 'build.json'), JSON.stringify(metadata))
    writeFileSync(join(directory, 'engine.wasm'), bytes)
  }
  return root
}

test('default preserves all four source directories', () => {
  const mapping = sdkEngineDirectories()
  assert.equal(Object.keys(mapping).length, 4)
  for (const [slot, source] of Object.entries(mapping)) assert.equal(slot, source)
  assert.equal(Object.keys(inspectSDKBuildProfile(fixture())).length, 4)
})

test('combined assignment profile preserves module bindings and native limits',()=>{
  const previous='experimental-fibers-simd-lazy-initializers-o2-iterative-calls-module-import-exports',profile=previous+'-assignments'
  const slot='quickjs-als-asyncify-wasm-atomics-fibers-shared-storage'
  assert.equal(sdkEngineDirectories(profile)[slot],sdkEngineDirectories(previous)[slot].replace('-atomics-fibers','-atomics-assignments-fibers'))
  assert.equal(Object.keys(inspectSDKBuildProfile(fixture(profile),profile)).length,6)
  for(const field of ['assignmentParser','moduleImportExports','interpreterFrames'])assert.throws(()=>inspectSDKBuildProfile(fixture(profile,(metadata,key)=>{if(key===slot)delete metadata[field]}),profile))
})

test('desktop alpha combines the advanced fiber engine with the proven heap-loop cooperative engine',()=>{
  const mapping=sdkEngineDirectories(desktopAlpha)
  const fibers=sdkEngineDirectories('experimental-fibers-simd-lazy-initializers-o2-iterative-calls-module-import-exports-assignments')
  const heapLoops=sdkEngineDirectories(candidate)
  for(const slot of ['quickjs-als-asyncify-cooperative','quickjs-als-asyncify-wasm-cooperative'])assert.equal(mapping[slot],heapLoops[slot])
  for(const slot of ['quickjs-als-asyncify-atomics-fibers-shared-storage','quickjs-als-asyncify-wasm-atomics-fibers-shared-storage'])assert.equal(mapping[slot],fibers[slot])
  assert.equal(Object.keys(inspectSDKBuildProfile(fixture(desktopAlpha),desktopAlpha)).length,6)
})

test('segmented diagnostic changes only the combined fiber slot and preserves all existing guards',()=>{
  const slot='quickjs-als-asyncify-wasm-atomics-fibers-shared-storage'
  const baseline=sdkEngineDirectories(desktopAlpha),mapping=sdkEngineDirectories(segmentedInterpreter)
  for(const key of Object.keys(baseline))assert.equal(mapping[key],key===slot?baseline[key].replace('-atomics-assignments','-atomics-interpreter-machine-one-caller50-assignments'):baseline[key])
  const engines=inspectSDKBuildProfile(fixture(segmentedInterpreter),segmentedInterpreter)
  assert.equal(Object.keys(engines).length,6)
  assert.equal(engines[slot].sourceDirectory,mapping[slot])
  for(const change of [m=>delete m.interpreterMachine,m=>m.interpreterMachine.stageSHA256='invalid',m=>m.interpreterMachine.scope='other',m=>m.binaryenOneCallerInlineMax=51,m=>m.noInline=true,m=>m.guestCallDepth.limit=256,m=>delete m.assignmentParser,m=>delete m.moduleImportExports]){
    assert.throws(()=>inspectSDKBuildProfile(fixture(segmentedInterpreter,(m,key)=>{if(key===slot)change(m)}),segmentedInterpreter))
  }
})

test('batched diagnostic requires both source stages and cannot masquerade as single-opcode dispatch',()=>{
  const slot='quickjs-als-asyncify-wasm-atomics-fibers-shared-storage'
  const baseline=sdkEngineDirectories(segmentedInterpreter),mapping=sdkEngineDirectories(batchedInterpreter)
  for(const key of Object.keys(baseline))assert.equal(mapping[key],key===slot?baseline[key].replace('-interpreter-machine-','-interpreter-machine-batched-'):baseline[key])
  assert.equal(Object.keys(inspectSDKBuildProfile(fixture(batchedInterpreter),batchedInterpreter)).length,6)
  for(const change of [m=>delete m.interpreterMachine.baseStageSHA256,m=>m.interpreterMachine.baseStageSHA256='bad',m=>m.interpreterMachine.variant='single-opcode-family-dispatch']){
    assert.throws(()=>inspectSDKBuildProfile(fixture(batchedInterpreter,(m,key)=>{if(key===slot)change(m)}),batchedInterpreter),/batched interpreter provenance/)
  }
  assert.throws(()=>inspectSDKBuildProfile(fixture(segmentedInterpreter,(m,key)=>{if(key===slot)m.interpreterMachine.variant='persistent-state-family-runs'}),segmentedInterpreter),/single-opcode interpreter variant/)
})

test('native UTF-8 diagnostic changes only the batched fiber WASM engine and validates its exact primitive contract',()=>{
  const slot='quickjs-als-asyncify-wasm-atomics-fibers-shared-storage'
  const baseline=sdkEngineDirectories(batchedInterpreter),mapping=sdkEngineDirectories(nativeUTF8)
  for(const key of Object.keys(baseline))assert.equal(mapping[key],key===slot?baseline[key]+'-native-utf8':baseline[key])
  assert.equal(Object.keys(inspectSDKBuildProfile(fixture(nativeUTF8),nativeUTF8)).length,6)
  const changes=[
    m=>delete m.nativeUTF8,
    m=>m.nativeUTF8.stageSHA256='bad',
    m=>m.nativeUTF8.bindingSHA256='bad',
    m=>m.nativeUTF8.operations=['other'],
    m=>m.nativeUTF8.interruptPollCodeUnits=0,
    m=>m.nativeUTF8.maxOutputBytes=2147483648,
    m=>m.nativeUTF8.extra=true,
  ]
  for(const change of changes)assert.throws(()=>inspectSDKBuildProfile(fixture(nativeUTF8,(m,key)=>{if(key===slot)change(m)}),nativeUTF8),/native UTF-8 provenance or limits/)
  assert.throws(()=>inspectSDKBuildProfile(fixture(batchedInterpreter,(m,key)=>{if(key===slot)m.nativeUTF8={}}),batchedInterpreter),/unexpected native UTF-8 metadata/)
})

test('native UTF-8 buffer profile changes only the native UTF-8 fiber WASM source',()=>{
  const slot='quickjs-als-asyncify-wasm-atomics-fibers-shared-storage'
  const baseline=sdkEngineDirectories(nativeUTF8),mapping=sdkEngineDirectories(nativeUTF8Buffer)
  assert.deepEqual(Object.keys(mapping),Object.keys(baseline))
  assert.equal(Object.keys(mapping).length,6)
  for(const key of Object.keys(baseline))assert.equal(mapping[key],baseline[key]+(key===slot?'-buffer':''))
  const engines=inspectSDKBuildProfile(fixture(nativeUTF8Buffer),nativeUTF8Buffer)
  for(const key of Object.keys(mapping))assert.equal(engines[key].sourceDirectory,mapping[key])
  assert.equal(Object.keys(sdkEngineDirectories()).length,4)
})

test('native UTF-8 buffer profile requires its exact primitive contract',()=>{
  const slot='quickjs-als-asyncify-wasm-atomics-fibers-shared-storage'
  const invalid={experimental:false,stageSHA256:'A'.repeat(64),bindingSHA256:'bad',intrinsics:['__qjsWriteUTF8'],operations:['encodeUTF8'],input:'any',target:'ArrayBuffer',ranges:'clamped',loneSurrogates:'preserve',partialCodePoints:true,interruptPollCodeUnits:0,encodedOutputAllocation:true}
  for(const [field,value] of Object.entries(invalid)){
    for(const change of [m=>delete m.nativeUTF8Buffer[field],m=>m.nativeUTF8Buffer[field]=value]){
      assert.throws(()=>inspectSDKBuildProfile(fixture(nativeUTF8Buffer,(m,key)=>{if(key===slot)change(m)}),nativeUTF8Buffer),/native UTF-8 buffer provenance or limits/)
    }
  }
  for(const change of [m=>delete m.nativeUTF8Buffer,m=>m.nativeUTF8Buffer.extra=true])assert.throws(()=>inspectSDKBuildProfile(fixture(nativeUTF8Buffer,(m,key)=>{if(key===slot)change(m)}),nativeUTF8Buffer),/native UTF-8 buffer provenance or limits/)
  for(const key of Object.keys(sdkEngineDirectories(nativeUTF8Buffer)).filter(key=>key!==slot))assert.throws(()=>inspectSDKBuildProfile(fixture(nativeUTF8Buffer,(m,current)=>{if(current===key)m.nativeUTF8Buffer={}}),nativeUTF8Buffer),/unexpected native UTF-8 buffer metadata/)
  for(const field of ['nativeUTF8','interpreterMachine','moduleImportExports','assignmentParser','compiledInitializers','interpreterFrames'])assert.throws(()=>inspectSDKBuildProfile(fixture(nativeUTF8Buffer,(m,key)=>{if(key===slot)delete m[field]}),nativeUTF8Buffer))
})

test('guest sampling diagnostic changes only the native UTF-8 fiber WASM source',()=>{
  const slot='quickjs-als-asyncify-wasm-atomics-fibers-shared-storage'
  const baseline=sdkEngineDirectories(nativeUTF8),mapping=sdkEngineDirectories(guestSampling)
  assert.deepEqual(Object.keys(mapping),Object.keys(baseline))
  assert.equal(Object.keys(mapping).length,6)
  for(const key of Object.keys(baseline))assert.equal(mapping[key],baseline[key]+(key===slot?'-guest-sampling':''))
  const engines=inspectSDKBuildProfile(fixture(guestSampling),guestSampling)
  for(const key of Object.keys(mapping))assert.equal(engines[key].sourceDirectory,mapping[key])
  assert.equal(Object.keys(sdkEngineDirectories()).length,4)
})

test('guest sampling diagnostic requires fixed limits and lowercase source hashes',()=>{
  const slot='quickjs-als-asyncify-wasm-atomics-fibers-shared-storage'
  const changes=[
    m=>delete m.guestSampling,
    ...['experimental','maxSamples','intervalMs','functionBytes','filenameBytes','retention','storage','maxStorageBytes','stageSHA256','bindingSHA256'].map(field=>m=>delete m.guestSampling[field]),
    ...Object.entries({experimental:false,maxSamples:513,intervalMs:21,functionBytes:97,filenameBytes:193,retention:'first512',storage:'guest heap',maxStorageBytes:172065}).map(([field,value])=>m=>m.guestSampling[field]=value),
    ...['stageSHA256','bindingSHA256'].flatMap(field=>['A'.repeat(64),'a'.repeat(63),'x'.repeat(64),null,123].map(value=>m=>m.guestSampling[field]=value)),
  ]
  for(const change of changes)assert.throws(()=>inspectSDKBuildProfile(fixture(guestSampling,(m,key)=>{if(key===slot)change(m)}),guestSampling),/guest sampling provenance or limits/)
})

test('guest sampling diagnostic rejects metadata in every other slot',()=>{
  const selected='quickjs-als-asyncify-wasm-atomics-fibers-shared-storage'
  for(const slot of Object.keys(sdkEngineDirectories(guestSampling)).filter(key=>key!==selected)){
    for(const value of [{experimental:true},null])assert.throws(()=>inspectSDKBuildProfile(fixture(guestSampling,(m,key)=>{if(key===slot)m.guestSampling=value}),guestSampling),/unexpected guest sampling metadata/)
  }
})

test('guest sampling diagnostic retains native UTF-8 and underlying engine provenance checks',()=>{
  const slot='quickjs-als-asyncify-wasm-atomics-fibers-shared-storage'
  for(const field of ['nativeUTF8','interpreterMachine','moduleImportExports','assignmentParser','compiledInitializers','interpreterFrames']){
    assert.throws(()=>inspectSDKBuildProfile(fixture(guestSampling,(m,key)=>{if(key===slot)delete m[field]}),guestSampling))
  }
})

test('module import/export candidate requires provenance without replacing old engines',()=>{
  const previous='experimental-fibers-simd-lazy-initializers-o2-iterative-calls',profile=previous+'-module-import-exports'
  const slot='quickjs-als-asyncify-wasm-atomics-fibers-shared-storage'
  assert.equal(sdkEngineDirectories(profile)[slot],sdkEngineDirectories(previous)[slot]+'-module-import-exports')
  assert.equal(Object.keys(inspectSDKBuildProfile(fixture(profile),profile)).length,6)
  for(const value of [undefined,{}, {stageSHA256:'bad'}])assert.throws(()=>inspectSDKBuildProfile(fixture(profile,(metadata,key)=>{if(key===slot)metadata.moduleImportExports=value}),profile),/module import\/export provenance/)
})

test('compiled initializer profile changes only the WASM fiber engine',()=>{
  const profile='experimental-fibers-simd-lazy-initializers',mapping=sdkEngineDirectories(profile),baseline=sdkEngineDirectories('experimental-fibers-simd-lazy')
  const slot='quickjs-als-asyncify-wasm-atomics-fibers-shared-storage'
  assert.equal(mapping[slot],baseline[slot]+'-compiled-initializers')
  for(const key of Object.keys(mapping))if(key!==slot)assert.equal(mapping[key],baseline[key])
  assert.equal(Object.keys(inspectSDKBuildProfile(fixture(profile),profile)).length,6)
})

for(const field of ['bindingSHA256','maxSourceBytes','maxCompiledBytes','scope'])test('rejects invalid initializer '+field,()=>{
  const profile='experimental-fibers-simd-lazy-initializers'
  const root=fixture(profile,metadata=>{if(metadata.compiledInitializers)delete metadata.compiledInitializers[field]})
  assert.throws(()=>inspectSDKBuildProfile(root,profile),/initializer metadata/)
})

test('O2 initializer candidate validates the actual optimization',()=>{
  const profile='experimental-fibers-simd-lazy-initializers-o2'
  assert.equal(Object.keys(inspectSDKBuildProfile(fixture(profile),profile)).length,6)
  assert.throws(()=>inspectSDKBuildProfile(fixture(profile,metadata=>{if(metadata.compiledInitializers)metadata.optimization='Oz'}),profile),/requires O2/)
})

test('iterative fiber candidate preserves native guards and requires heap-frame provenance',()=>{
  const profile='experimental-fibers-simd-lazy-initializers-o2-iterative-calls'
  const slot='quickjs-als-asyncify-wasm-atomics-fibers-shared-storage'
  assert.equal(sdkEngineDirectories(profile)[slot],sdkEngineDirectories('experimental-fibers-simd-lazy-initializers-o2')[slot]+'-iterative-calls')
  assert.equal(Object.keys(inspectSDKBuildProfile(fixture(profile),profile)).length,6)
  for(const change of [m=>delete m.interpreterFrames,m=>m.interpreterFrames.limit=8192,m=>m.interpreterFrames.stageSHA256='bad',m=>m.guestCallDepth.limit=256,m=>m.guestCallDepth.nativeReentryLimit=128,m=>m.fibers.stackBytes=1048576]){
    assert.throws(()=>inspectSDKBuildProfile(fixture(profile,(metadata,key)=>{if(key===slot)change(metadata)}),profile),/iterative fiber frame provenance/)
  }
})
test('O2 assignment parser candidate selects and validates a separate engine',()=>{
  const profile='experimental-fibers-simd-lazy-initializers-o2-assignments'
  const slot='quickjs-als-asyncify-wasm-atomics-fibers-shared-storage'
  const baseline=sdkEngineDirectories('experimental-fibers-simd-lazy-initializers-o2'),mapping=sdkEngineDirectories(profile)
  assert.equal(mapping[slot],baseline[slot].replace('-atomics-fibers','-atomics-assignments-fibers'))
  for(const key of Object.keys(mapping))if(key!==slot)assert.equal(mapping[key],baseline[key])
  assert.equal(Object.keys(inspectSDKBuildProfile(fixture(profile),profile)).length,6)
  for(const value of [undefined,{}, {stageSHA256:'invalid'}])assert.throws(()=>inspectSDKBuildProfile(fixture(profile,(metadata,key)=>{if(key===slot)metadata.assignmentParser=value}),profile),/assignment parser metadata/)
})
test('fairness profile selects isolated engines and validates the combined WASM guard',()=>{
 const profile='experimental-fibers-simd-lazy-fairness',mapping=sdkEngineDirectories(profile)
 assert.equal(mapping['quickjs-als-asyncify-atomics-fibers-shared-storage'],'quickjs-als-asyncify-atomics-fibers-shared-storage-fiber-fairness')
 assert.equal(mapping['quickjs-als-asyncify-wasm-atomics-fibers-shared-storage'],'quickjs-als-asyncify-wasm-atomics-fibers-shared-storage-simd-lazy-wasm-fiber-fairness')
 assert.equal(Object.keys(inspectSDKBuildProfile(fixture(profile),profile)).length,6)
 for(const field of ['experimental','status','stageSHA256','wasmGuard','scope']){
  const root=fixture(profile,(metadata,slot)=>{if(slot.includes('-wasm-atomics-fibers'))delete metadata.fibers.fairness[field]})
  assert.throws(()=>inspectSDKBuildProfile(root,profile),/fairness metadata/)
 }
 const root=fixture('experimental-fibers',(metadata,slot)=>{if(slot.includes('-fibers'))metadata.fibers.fairness={experimental:true}})
 assert.throws(()=>inspectSDKBuildProfile(root,'experimental-fibers'),/unexpected fiber fairness/)
})
test('experimental fibers adds two exact engine slots without replacing defaults',()=>{
  const defaults=sdkEngineDirectories(),mapping=sdkEngineDirectories('experimental-fibers')
  assert.equal(Object.keys(mapping).length,6)
  for(const [slot,source] of Object.entries(defaults))assert.equal(mapping[slot],source)
  assert.equal(Object.keys(inspectSDKBuildProfile(fixture('experimental-fibers'),'experimental-fibers')).length,6)
})
test('experimental SIMD changes only the WASM fiber source directory',()=>{
  const before=sdkEngineDirectories('experimental-fibers'),after=sdkEngineDirectories('experimental-fibers-simd')
  assert.equal(Object.keys(after).length,6)
  for(const slot of Object.keys(before))assert.equal(after[slot],before[slot]+(slot.includes('-wasm-atomics-fibers')?'-simd':''))
  assert.equal(Object.keys(inspectSDKBuildProfile(fixture('experimental-fibers-simd'),'experimental-fibers-simd')).length,6)
})
test('lazy SIMD changes only the WASM fiber directory',()=>{
  const before=sdkEngineDirectories('experimental-fibers-simd'),after=sdkEngineDirectories('experimental-fibers-simd-lazy')
  for(const slot of Object.keys(before))assert.equal(after[slot],before[slot]+(slot.includes('-wasm-atomics-fibers')?'-lazy-wasm':''))
  assert.equal(Object.keys(inspectSDKBuildProfile(fixture('experimental-fibers-simd-lazy'),'experimental-fibers-simd-lazy')).length,6)
})
for(const [field,value] of [['experimental',false],['validation','lazy'],['stageSHA256','x'.repeat(64)],['stageSHA256',null]])test('lazy SIMD rejects invalid '+field+' '+value,()=>{
  const profile='experimental-fibers-simd-lazy'
  const root=fixture(profile,(metadata,slot)=>{if(slot.includes('-wasm-atomics-fibers'))metadata.guestWasm.lazyCompilation[field]=value})
  assert.throws(()=>inspectSDKBuildProfile(root,profile),/lazy compilation metadata/)
})
for(const profile of ['default',candidate,'sync-o2','experimental-fibers','experimental-fibers-simd','experimental-fibers-simd-lazy'])test('rejects lazy metadata in unselected slot '+profile,()=>{
  const root=fixture(profile,(metadata,slot)=>{if(slot==='quickjs-als-wasm')metadata.guestWasm.lazyCompilation={experimental:true,validation:'eager',stageSHA256:'c'.repeat(64)}})
  assert.throws(()=>inspectSDKBuildProfile(root,profile),/unexpected lazy/)
})
for(const field of ['experimental','validation','stageSHA256'])test('lazy SIMD rejects missing '+field,()=>{
  const profile='experimental-fibers-simd-lazy',root=fixture(profile,(metadata,slot)=>{if(slot.includes('-wasm-atomics-fibers'))delete metadata.guestWasm.lazyCompilation[field]})
  assert.throws(()=>inspectSDKBuildProfile(root,profile),/lazy compilation metadata/)
})
for(const field of ['experimental','foundationSHA256','operationsSHA256'])test('SIMD profile rejects missing '+field,()=>{
  const root=fixture('experimental-fibers-simd',(metadata,slot)=>{if(slot.includes('-wasm-atomics-fibers'))delete metadata.guestWasm.simd[field]})
  assert.throws(()=>inspectSDKBuildProfile(root,'experimental-fibers-simd'),/SIMD metadata/)
})
for(const field of ['atomics','fibers','sharedStorage','stackBytes','quickJSStackBytes','nativeHeadroomBytes','maxBytes','maxAllocations','hash','scope'])test('experimental fibers rejects invalid '+field,()=>{
  const root=fixture('experimental-fibers',(metadata,slot)=>{
    if(!slot.includes('-fibers'))return
    if(['atomics','fibers','sharedStorage'].includes(field))delete metadata[field]
    else if(['stackBytes','quickJSStackBytes','nativeHeadroomBytes'].includes(field))metadata.fibers[field]=1
    else if(field==='hash')metadata.sharedStorage.bindingSHA256='missing'
    else metadata.sharedStorage[field]=0
  })
  assert.throws(()=>inspectSDKBuildProfile(root,'experimental-fibers'),/experimental fiber/)
})
test('candidate changes only the two cooperative slots and records metadata', () => {
  const defaults = sdkEngineDirectories(), mapping = sdkEngineDirectories(candidate)
  for (const slot of Object.keys(mapping)) assert.equal(mapping[slot] === defaults[slot], !slot.includes('asyncify'))
  const engines = inspectSDKBuildProfile(fixture(candidate), candidate)
  for (const [slot, engine] of Object.entries(engines)) {
    assert.equal(engine.sourceDirectory, mapping[slot])
    assert.equal(engine.metadataPath, 'runtime/' + slot + '/build.json')
    assert.match(engine.metadataSHA256, /^[a-f0-9]{64}$/)
    assert.equal(engine.wasmSHA256, engine.metadata.wasmSha256)
    assert.equal(engine.wasmBytes, engine.metadata.wasmBytes)
  }
})
test('sync-o2 changes only sync slots and preserves default cooperative engines', () => {
  const defaults = sdkEngineDirectories(), mapping = sdkEngineDirectories('sync-o2')
  assert.equal(mapping['quickjs-als'], 'quickjs-als-o2')
  assert.equal(mapping['quickjs-als-wasm'], 'quickjs-als-wasm-o2')
  const engines = inspectSDKBuildProfile(fixture('sync-o2'), 'sync-o2')
  for (const slot of Object.keys(mapping)) {
    assert.equal(mapping[slot] === defaults[slot], slot.includes('asyncify'))
    assert.equal(engines[slot].metadata.optimization, slot.includes('asyncify') ? 'Oz' : 'O2')
  }
})
test('sync-o2 rejects a selected sync engine with Oz optimization', () => {
  const root = fixture('sync-o2', (metadata, slot) => {if (slot === 'quickjs-als-wasm') metadata.optimization = 'Oz'})
  assert.throws(() => inspectSDKBuildProfile(root, 'sync-o2'), /requires O2/)
})
for (const profile of ['', '../candidate', 'cooperative-o3', null, {}]) test('rejects non-allowlisted profile ' + JSON.stringify(profile), () => {
  assert.throws(() => sdkEngineDirectories(profile), /Unknown SDK build profile/)
})
for (const field of ['wasmBytes', 'wasmSha256']) test('rejects mismatched ' + field, () => {
  const root = fixture('default', metadata => metadata[field] = field === 'wasmBytes' ? -1 : '0'.repeat(64))
  assert.throws(() => inspectSDKBuildProfile(root), /do not match/)
})
test('rejects wrong runtime mode', () => {
  const root = fixture('default', metadata => metadata.asyncify = !metadata.asyncify)
  assert.throws(() => inspectSDKBuildProfile(root), /runtime slot/)
})
for (const field of ['optimization', 'generatorQueue', 'profileYields', 'assignmentParser', 'wasmPoll', 'dispatchBatch', 'dispatchUnwind', 'heapLoops']) test('rejects candidate missing ' + field, () => {
  const root = fixture(candidate, (metadata, slot) => {
    if (!slot.includes('asyncify-wasm')) return
    if (['profileYields', 'wasmPoll'].includes(field)) delete metadata.cooperative[field]
    else if (['dispatchBatch', 'dispatchUnwind', 'heapLoops'].includes(field)) delete metadata.guestWasm[field]
    else delete metadata[field]
  })
  assert.throws(() => inspectSDKBuildProfile(root, candidate), /missing/)
})
test('rejects a source directory symlink', () => {
  const root = fixture(), alias = join(root, 'alias')
  symlinkSync(join(root, 'quickjs-als'), alias)
  assert.throws(() => inspectSDKEngine(alias, 'quickjs-als'), /symlink/)
})
for(const slot of ['quickjs-als','quickjs-als-wasm'])for(const value of [undefined,{}, {stageSHA256:'a'.repeat(64)}, {stageSHA256:'invalid',bindingSHA256:'b'.repeat(64)}])test('sync-o2 rejects missing requireESM provenance '+slot+' '+JSON.stringify(value),()=>{
  const root=fixture('sync-o2',(metadata,key)=>{if(key===slot)metadata.requireESM=value})
  assert.throws(()=>inspectSDKBuildProfile(root,'sync-o2'),/requires requireESM provenance/)
})
