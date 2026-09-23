import {readFileSync, lstatSync} from 'node:fs'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'

const slots = ['quickjs-als', 'quickjs-als-wasm', 'quickjs-als-asyncify-cooperative', 'quickjs-als-asyncify-wasm-cooperative']
const candidate = 'cooperative-o2-heap-loops-batch16'
const vmCandidate = 'sync-o2-vm-modules'
const fiberCandidate = 'experimental-fibers'
const simdCandidate = 'experimental-fibers-simd'
const lazyCandidate = 'experimental-fibers-simd-lazy'
const initializerCandidate = 'experimental-fibers-simd-lazy-initializers'
const initializerO2Candidate = 'experimental-fibers-simd-lazy-initializers-o2'
const iterativeFiberCandidate = 'experimental-fibers-simd-lazy-initializers-o2-iterative-calls'
const moduleExportsCandidate = iterativeFiberCandidate+'-module-import-exports'
const moduleAssignmentsCandidate = moduleExportsCandidate+'-assignments'
const desktopAlphaCandidate = moduleAssignmentsCandidate+'-cooperative-heap-loops'
const segmentedInterpreterCandidate = desktopAlphaCandidate+'-segmented-interpreter'
const batchedInterpreterCandidate = segmentedInterpreterCandidate+'-batched'
const nativeUTF8Candidate = batchedInterpreterCandidate+'-native-utf8'
const nativeUTF8BufferCandidate = nativeUTF8Candidate+'-buffer'
const guestSamplingCandidate = nativeUTF8Candidate+'-guest-sampling'
const initializerParserCandidate = 'experimental-fibers-simd-lazy-initializers-o2-assignments'
const fairnessCandidate = 'experimental-fibers-simd-lazy-fairness'
const fiberSlots=['quickjs-als-asyncify-atomics-fibers-shared-storage','quickjs-als-asyncify-wasm-atomics-fibers-shared-storage']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

export function sdkEngineDirectories(profile = 'default') {
  if(profile===nativeUTF8BufferCandidate){
    const mapping=sdkEngineDirectories(nativeUTF8Candidate)
    mapping[fiberSlots[1]]+='-buffer'
    return mapping
  }
  if(profile===guestSamplingCandidate){
    const mapping=sdkEngineDirectories(nativeUTF8Candidate)
    mapping[fiberSlots[1]]+='-guest-sampling'
    return mapping
  }
  if(profile===segmentedInterpreterCandidate||profile===batchedInterpreterCandidate||profile===nativeUTF8Candidate){
    const mapping=sdkEngineDirectories(desktopAlphaCandidate)
    const variant=profile===segmentedInterpreterCandidate?'':'-batched'
    mapping[fiberSlots[1]]=mapping[fiberSlots[1]].replace('-atomics-assignments',`-atomics-interpreter-machine${variant}-one-caller50-assignments`)
    if(profile===nativeUTF8Candidate)mapping[fiberSlots[1]]+='-native-utf8'
    return mapping
  }
  if(profile===desktopAlphaCandidate){
    const mapping=sdkEngineDirectories(moduleAssignmentsCandidate)
    const cooperative=sdkEngineDirectories(candidate)
    for(const slot of ['quickjs-als-asyncify-cooperative','quickjs-als-asyncify-wasm-cooperative'])mapping[slot]=cooperative[slot]
    return mapping
  }
  if(profile===moduleAssignmentsCandidate){const mapping=sdkEngineDirectories(moduleExportsCandidate);mapping[fiberSlots[1]]=mapping[fiberSlots[1]].replace('-atomics-fibers','-atomics-assignments-fibers');return mapping}
  if(profile===moduleExportsCandidate){const mapping=sdkEngineDirectories(iterativeFiberCandidate);mapping[fiberSlots[1]]+='-module-import-exports';return mapping}
  if(profile===iterativeFiberCandidate){const mapping=sdkEngineDirectories(initializerO2Candidate);mapping[fiberSlots[1]]+='-iterative-calls';return mapping}
  if(profile===initializerParserCandidate){const mapping=sdkEngineDirectories(initializerO2Candidate);mapping[fiberSlots[1]]=mapping[fiberSlots[1]].replace('-atomics-fibers','-atomics-assignments-fibers');return mapping}
  if(profile===initializerO2Candidate){const mapping=sdkEngineDirectories(initializerCandidate);mapping[fiberSlots[1]]=mapping[fiberSlots[1]].replace('-wasm-atomics','-wasm-o2-atomics');return mapping}
  if(profile===initializerCandidate){const mapping=sdkEngineDirectories(lazyCandidate);mapping[fiberSlots[1]]+='-compiled-initializers';return mapping}
  if (profile !== 'default' && profile !== candidate && profile !== 'sync-o2' && profile !== vmCandidate && profile !== fiberCandidate && profile !== simdCandidate && profile !== lazyCandidate && profile !== fairnessCandidate) throw new Error('Unknown SDK build profile: ' + String(profile))
  const mapping = Object.fromEntries(slots.map(slot => [slot, slot]))
  if(profile===fiberCandidate||profile===simdCandidate||profile===lazyCandidate||profile===fairnessCandidate)for(const slot of fiberSlots)mapping[slot]=slot
  if(profile===simdCandidate)mapping[fiberSlots[1]]=fiberSlots[1]+'-simd'
  if(profile===lazyCandidate)mapping[fiberSlots[1]]=fiberSlots[1]+'-simd-lazy-wasm'
  if(profile===fairnessCandidate){mapping[fiberSlots[0]]=fiberSlots[0]+'-fiber-fairness';mapping[fiberSlots[1]]=fiberSlots[1]+'-simd-lazy-wasm-fiber-fairness'}
  if (profile === 'sync-o2' || profile === vmCandidate) {
    mapping['quickjs-als'] = profile===vmCandidate?'quickjs-als-o2-vm-modules':'quickjs-als-o2'
    mapping['quickjs-als-wasm'] = profile===vmCandidate?'quickjs-als-wasm-o2-vm-modules':'quickjs-als-wasm-o2'
  }
  if (profile === candidate) {
    mapping['quickjs-als-asyncify-cooperative'] = 'quickjs-als-asyncify-o2-generator-queue-yield-profile-cooperative'
    mapping['quickjs-als-asyncify-wasm-cooperative'] = 'quickjs-als-asyncify-wasm-o2-generator-queue-yield-profile-poll4096-cooperative-batch16-assignments-unwind-heap-loops'
  }
  return mapping
}

export function inspectSDKEngine(directory, slot, profile = 'default') {
  if(profile===nativeUTF8BufferCandidate){
    const engine=inspectSDKEngine(directory,slot,nativeUTF8Candidate)
    const buffer=engine.metadata.nativeUTF8Buffer
    if(slot===fiberSlots[1]){
      const keys=['bindingSHA256','encodedOutputAllocation','experimental','input','interruptPollCodeUnits','intrinsics','loneSurrogates','operations','partialCodePoints','ranges','stageSHA256','target']
      if(!buffer||!isDeepStrictEqual(Object.keys(buffer).sort(),keys)||buffer.experimental!==true||
        ![buffer.stageSHA256,buffer.bindingSHA256].every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value))||
        !isDeepStrictEqual(buffer.intrinsics,['__qjsUTF8ByteLength','__qjsWriteUTF8'])||!isDeepStrictEqual(buffer.operations,['utf8ByteLength','writeUTF8'])||
        buffer.input!=='string'||buffer.target!=='Uint8Array'||buffer.ranges!=='strict view-relative integer offset and limit'||
        buffer.loneSurrogates!=='U+FFFD'||buffer.partialCodePoints!==false||buffer.interruptPollCodeUnits!==65536||buffer.encodedOutputAllocation!==false)throw Error('SDK native UTF-8 buffer provenance or limits are invalid')
    }else if(Object.hasOwn(engine.metadata,'nativeUTF8Buffer'))throw Error('SDK engine has unexpected native UTF-8 buffer metadata')
    return {...engine,sourceDirectory:sdkEngineDirectories(profile)[slot]}
  }
  if(profile===guestSamplingCandidate){
    const engine=inspectSDKEngine(directory,slot,nativeUTF8Candidate)
    const sampling=engine.metadata.guestSampling
    if(slot===fiberSlots[1]){
      if(!sampling||sampling.experimental!==true||sampling.maxSamples!==512||sampling.intervalMs!==20||
        sampling.functionBytes!==96||sampling.filenameBytes!==192||
        sampling.retention!=='latest512'||sampling.storage!=='runtime-owned host allocation outside guest heap quota'||sampling.maxStorageBytes!==172064||
        ![sampling.stageSHA256,sampling.bindingSHA256].every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)))throw Error('SDK guest sampling provenance or limits are invalid')
    }else if(Object.hasOwn(engine.metadata,'guestSampling'))throw Error('SDK engine has unexpected guest sampling metadata')
    return {...engine,sourceDirectory:sdkEngineDirectories(profile)[slot]}
  }
  if(profile===segmentedInterpreterCandidate||profile===batchedInterpreterCandidate||profile===nativeUTF8Candidate){
    const engine=inspectSDKEngine(directory,slot,desktopAlphaCandidate)
    if(slot===fiberSlots[1]){
      const {interpreterMachine,binaryenOneCallerInlineMax,noInline}=engine.metadata
      if(!/^[a-f0-9]{64}$/.test(interpreterMachine?.stageSHA256??'')||
        interpreterMachine?.scope!=='ordinary opcode families with coordinator-owned entry, calls, yields and unwind'||
        binaryenOneCallerInlineMax!==50||noInline!==false)throw Error('SDK segmented interpreter provenance or compiler policy is invalid')
      if(profile===batchedInterpreterCandidate||profile===nativeUTF8Candidate){
        if(interpreterMachine.variant!=='persistent-state-family-runs'||!/^[a-f0-9]{64}$/.test(interpreterMachine.baseStageSHA256??''))throw Error('SDK batched interpreter provenance is invalid')
      }else if(interpreterMachine.variant!==undefined&&interpreterMachine.variant!=='single-opcode-family-dispatch')throw Error('SDK single-opcode interpreter variant is invalid')
      const nativeUTF8=engine.metadata.nativeUTF8
      if(profile===nativeUTF8Candidate){
        const keys=['allocation','bindingSHA256','input','interruptPollCodeUnits','intrinsic','loneSurrogates','maxOutputBytes','operations','output','stageSHA256']
        if(!nativeUTF8||!isDeepStrictEqual(Object.keys(nativeUTF8).sort(),keys)||
          !/^[a-f0-9]{64}$/.test(nativeUTF8.stageSHA256??'')||!/^[a-f0-9]{64}$/.test(nativeUTF8.bindingSHA256??'')||
          nativeUTF8.intrinsic!=='__qjsEncodeUTF8'||!isDeepStrictEqual(nativeUTF8.operations,['encodeUTF8'])||
          nativeUTF8.input!=='string'||nativeUTF8.output!=='ArrayBuffer'||
          nativeUTF8.allocation!=='QuickJS runtime allocator, fresh guest-owned bytes'||nativeUTF8.loneSurrogates!=='U+FFFD'||
          nativeUTF8.interruptPollCodeUnits!==65536||nativeUTF8.maxOutputBytes!==2147483647)throw Error('SDK native UTF-8 provenance or limits are invalid')
      }else if(nativeUTF8!==undefined)throw Error('SDK engine has unexpected native UTF-8 metadata')
    }
    return {...engine,sourceDirectory:sdkEngineDirectories(profile)[slot]}
  }
  if(profile===desktopAlphaCandidate)return inspectSDKEngine(directory,slot,slots.includes(slot)?candidate:moduleAssignmentsCandidate)
  const mapping = sdkEngineDirectories(profile)
  const combinedAssignments=profile===moduleAssignmentsCandidate
  if(combinedAssignments)profile=moduleExportsCandidate
  const moduleImportExports=profile===moduleExportsCandidate&&slot===fiberSlots[1]
  if(profile===moduleExportsCandidate)profile=iterativeFiberCandidate
  const iterativeFiber=profile===iterativeFiberCandidate&&slot===fiberSlots[1]
  if(profile===iterativeFiberCandidate)profile=initializerO2Candidate
  const assignmentParser=(combinedAssignments||profile===initializerParserCandidate)&&slot===fiberSlots[1]
  if(profile===initializerParserCandidate)profile=initializerO2Candidate
  const initializerO2=profile===initializerO2Candidate&&slot===fiberSlots[1]
  const initializers=(profile===initializerCandidate||profile===initializerO2Candidate)&&slot===fiberSlots[1]
  if(profile===initializerCandidate||profile===initializerO2Candidate)profile=lazyCandidate
  if (!Object.hasOwn(mapping, slot)) throw new Error('Unknown SDK engine slot')
  const sourceDirectory = mapping[slot]
  for (const path of [directory, join(directory, 'build.json'), join(directory, 'engine.wasm')]) {
    if (lstatSync(path).isSymbolicLink()) throw new Error('SDK engine symlink: ' + path)
  }
  const metadataBytes = readFileSync(join(directory, 'build.json'))
  const metadata = JSON.parse(metadataBytes.toString('utf8'))
  if(moduleImportExports&&!/^[a-f0-9]{64}$/.test(metadata.moduleImportExports?.stageSHA256??''))throw Error('SDK module import/export provenance is invalid')
  if(iterativeFiber&&(!/^[a-f0-9]{64}$/.test(metadata.interpreterFrames?.stageSHA256??'')||metadata.interpreterFrames.limit!==4096||metadata.guestCallDepth?.limit!==192||metadata.guestCallDepth?.nativeReentryLimit!==64||metadata.fibers?.stackBytes!==524288))throw Error('SDK iterative fiber frame provenance or unchanged native guards are invalid')
  if(assignmentParser&&!/^[a-f0-9]{64}$/.test(metadata.assignmentParser?.stageSHA256??''))throw Error('SDK assignment parser metadata is invalid')
  if(initializerO2&&metadata.optimization!=='O2')throw Error('SDK initializer O2 profile requires O2 optimization')
  if(initializers){
    const value=metadata.compiledInitializers
    if(!value||!/^[a-f0-9]{64}$/.test(value.bindingSHA256??'')||value.maxSourceBytes!==2097152||value.maxCompiledBytes!==8388608||value.scope!=='Host-only same-engine initialization, no guest bytecode API')throw Error('SDK compiled initializer metadata is invalid')
  }else if(Object.hasOwn(metadata,'compiledInitializers'))throw Error('SDK engine has unexpected compiled initializer metadata')
  const wasm = readFileSync(join(directory, 'engine.wasm'))
  const wasmSHA256 = hash(wasm)
  if (metadata.wasmSha256 !== wasmSHA256 || metadata.wasmBytes !== wasm.length) throw new Error('SDK engine bytes do not match build metadata: ' + slot)
  const cooperative = slot.includes('asyncify')
  if (metadata.asyncify !== cooperative || Boolean(metadata.guestWasm) !== slot.includes('-wasm')) throw new Error('SDK engine does not match runtime slot: ' + slot)
  if((profile===simdCandidate||profile===lazyCandidate||profile===fairnessCandidate)&&slot===fiberSlots[1]){
    const simd=metadata.guestWasm?.simd
    if(!simd||simd.experimental!==true||![simd.foundationSHA256,simd.operationsSHA256].every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)))throw new Error('SDK experimental SIMD metadata is invalid')
  }
  if((profile===lazyCandidate||profile===fairnessCandidate)&&slot===fiberSlots[1]){
    const lazy=metadata.guestWasm?.lazyCompilation
    if(!lazy||lazy.experimental!==true||lazy.validation!=='eager'||typeof lazy.stageSHA256!=='string'||!/^[a-f0-9]{64}$/.test(lazy.stageSHA256))throw new Error('SDK experimental lazy compilation metadata is invalid')
  }else if(metadata.guestWasm&&Object.hasOwn(metadata.guestWasm,'lazyCompilation'))throw new Error('SDK engine has unexpected lazy compilation metadata')
  if(profile===fairnessCandidate&&fiberSlots.includes(slot)){
    const fairness=metadata.fibers?.fairness,combined=slot===fiberSlots[1]
    const guardedScope='JavaScript bytecode branch polls only, outside native WASM operations and imported callbacks'
    if(!fairness||fairness.experimental!==true||fairness.status!==3||!/^[a-f0-9]{64}$/.test(fairness.stageSHA256??'')||
      (combined?(fairness.wasmGuard!==true||fairness.scope!==guardedScope):(!['JavaScript bytecode branch polls only',guardedScope].includes(fairness.scope)||Boolean(fairness.wasmGuard))))throw new Error('SDK experimental fiber fairness metadata is invalid')
  }else if(metadata.fibers&&Object.hasOwn(metadata.fibers,'fairness'))throw new Error('SDK engine has unexpected fiber fairness metadata')
  if(fiberSlots.includes(slot)){
    const f=metadata.fibers,s=metadata.sharedStorage,isHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
    if(metadata.atomics!==true||!f||!s||![f.bindingSHA256,f.buildStageSHA256,s.bindingSHA256,s.atomicWaitStageSHA256,s.buildStageSHA256].every(isHash)||f.stackBytes!==524288||f.quickJSStackBytes!==393216||f.nativeHeadroomBytes!==131072||f.quickJSStackBytes+f.nativeHeadroomBytes!==f.stackBytes||s.maxBytes!==16777216||s.maxAllocations!==256)throw new Error('SDK experimental fiber metadata is invalid')
    if(f.scope!=='experimental scheduler-owned QTS_Call and QTS_Eval continuations, not WASM threads'||s.scope!==(slot.includes('-wasm')?'group-owned SAB and WASM memory, message leases and single-engine scheduler-owned atomic operations':'engine-owned fixed SAB storage, message leases and native scheduler-owned atomic waits; not shared WASM'))throw new Error('SDK experimental fiber scope is invalid')
  }
  if ((profile === 'sync-o2' || profile === vmCandidate) && !cooperative && metadata.optimization !== 'O2') throw new Error('SDK sync-o2 engine requires O2 optimization')
  if(profile==='sync-o2'&&!cooperative){
    const requireESM=metadata.requireESM
    if(!requireESM||![requireESM.stageSHA256,requireESM.bindingSHA256].every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)))throw Error('SDK sync-o2 engine requires requireESM provenance: '+slot)
  }
  if(profile===vmCandidate&&!cooperative){
    const vm=metadata.vmModules
    if(!vm||![vm.stageSHA256,vm.bindingSHA256,vm.guestAPISHA256,vm.dynamicImportStageSHA256].every(value=>/^[a-f0-9]{64}$/.test(value))||vm.maxLiveHandles!==32||vm.maxCreatedHandles!==4096||vm.maxSourceBytes!==1048576||vm.maxSyntheticExports!==128||vm.maxPendingImports!==32||vm.maxImportBytecodes!==4096||vm.scope!=='async module graphs and owned module or namespace dynamic import callbacks; no cached data')throw new Error('SDK VM module candidate metadata is invalid')
  }
  if (profile === candidate && cooperative) {
    if (metadata.optimization !== 'O2' || !metadata.generatorQueue || metadata.cooperative?.profileYields !== true) throw new Error('SDK candidate is missing cooperative O2 features')
    if (slot.includes('-wasm') && (!metadata.assignmentParser || metadata.cooperative.wasmPoll !== 4096 || metadata.guestWasm.dispatchBatch !== 16 || metadata.guestWasm.dispatchUnwind !== true || metadata.guestWasm.heapLoops !== true)) throw new Error('SDK candidate is missing heap-loop features')
  }
  return {sourceDirectory, metadataPath: 'runtime/' + slot + '/build.json', metadataSHA256: hash(metadataBytes), wasmSHA256, wasmBytes: wasm.length, metadata}
}

export function inspectSDKBuildProfile(publicDirectory, profile = 'default') {
  return Object.fromEntries(Object.entries(sdkEngineDirectories(profile)).map(([slot, source]) => [slot, inspectSDKEngine(join(publicDirectory, source), slot, profile)]))
}

/** Check profile claims against the packaged files, without consulting the source tree. */
export function verifySDKEngineManifest(root, manifest) {
  const hasProfile = Object.hasOwn(manifest, 'buildProfile'), hasEngines = Object.hasOwn(manifest, 'engines')
  if (!hasProfile && !hasEngines) return
  if (!hasProfile || !hasEngines) throw new Error('SDK profile and engine mappings must appear together')
  if (typeof manifest.buildProfile !== 'string') throw new Error('Invalid SDK build profile')
  const mapping = sdkEngineDirectories(manifest.buildProfile)
  const engines = manifest.engines
  if (!engines || typeof engines !== 'object' || Array.isArray(engines) || !isDeepStrictEqual(Object.keys(engines).sort(), Object.keys(mapping).sort())) throw new Error('SDK engine mappings must contain exactly the selected profile runtime slots')
  for (const slot of Object.keys(mapping)) {
    const directory = join(root, 'runtime', slot)
    for (const file of ['core.mjs', 'engine.mjs', ...(slot.includes('asyncify') ? ['ffi.mjs'] : [])]) {
      const stat = lstatSync(join(directory, file))
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid SDK engine loader: ' + slot + '/' + file)
    }
    const actual = inspectSDKEngine(directory, slot, manifest.buildProfile)
    if (!isDeepStrictEqual(engines[slot], actual)) throw new Error('SDK engine manifest does not match packaged engine: ' + slot)
  }
}
