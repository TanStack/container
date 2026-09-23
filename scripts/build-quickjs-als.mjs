import { readFileSync, writeFileSync, mkdirSync, copyFileSync, cpSync, mkdtempSync, readdirSync } from 'node:fs'
import {tmpdir} from 'node:os'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
import {stageConstructorMetadata} from './stage-constructor-metadata.mjs'
import {stageInspectionWrapper} from './stage-inspection-wrapper.mjs'
import {stageCallDepth,guestCallDepthLimit,nativeReentryDepthLimit} from './stage-call-depth.mjs'
import {stageValidatorControl} from './stage-validator-control.mjs'
import {stageValidatorLocation} from './stage-validator-location.mjs'
import {stageInterpreterFrames} from './stage-interpreter-frames.mjs'
import {stageInterpreterProperties} from './stage-interpreter-properties.mjs'
import {stageInterpreterMachine} from './stage-interpreter-machine.mjs'
import {stageBatchedInterpreterMachine} from './stage-interpreter-machine-batched.mjs'
import {stageGeneratorResume} from './stage-generator-resume.mjs'
import {stageVMModuleRuntime} from './stage-vm-module-compile.mjs'
import {stageOpcodePatterns} from './stage-opcode-patterns.mjs'
import {stageNativeDispatch} from './stage-native-dispatch.mjs'
import {stageAsyncGeneratorQueue} from './stage-async-generator-queue.mjs'
import {stageWasmStackDiagnostics} from './stage-wasm-stack-diagnostics.mjs'
import {stageJobPump} from './stage-job-pump.mjs'
import {stageLocalReferenceBoundary} from './stage-local-reference-boundary.mjs'
import {stageGasCostRead} from './stage-gas-cost-read.mjs'
import {stageSourcePositionCache} from './stage-source-position-cache.mjs'
import {stageCooperativeInterrupt} from './stage-cooperative-interrupt.mjs'
import {stageWasmDispatch} from './stage-wasm-dispatch.mjs'
import {stageWasmAtomics} from './stage-wasm-atomics.mjs'
import {stageProcessTermination} from './stage-process-termination.mjs'
import {stageAssignmentParser} from './stage-assignment-parser.mjs'
import {stageRequireESM} from './stage-require-esm.mjs'
import {stageModuleImportExports} from './stage-module-import-exports.mjs'
import {stageAtomicWait} from './stage-atomic-wait.mjs'
import {stageSharedWasmMemory} from './stage-shared-wasm-memory.mjs'
import {stageSharedBufferViews} from './stage-shared-buffer-views.mjs'
import {stageSharedAtomicPointers} from './stage-shared-atomic-pointers.mjs'
import {stageNativeUTF8} from './stage-native-utf8.mjs'
import {normalizeCompilerSourcePaths,normalizeInspectionWrapperPaths} from './generated-engine-paths.mjs'

// Source checkout must be the pinned upstream revision with our patch applied.
// No package install scripts or guest code execute in this build.
const optimizationArgument=process.argv.slice(2).find(x=>x.startsWith('--opt='))
const optimization=optimizationArgument?.slice(6)??'Oz'
if(!['O1','O2','O3','Oz'].includes(optimization))throw new Error('Expected --opt=O1, O2, O3, or Oz')
const guestWasm = process.argv.includes('--wasm')
const simd = process.argv.includes('--simd')
const lazyWasm = process.argv.includes('--lazy-wasm')
if(lazyWasm&&!guestWasm)throw Error('Lazy WASM candidate requires --wasm')
const sortDiagnostics=process.argv.includes('--sort-diagnostics')
const initializerProbe=process.argv.includes('--initializer-probe')
const compiledInitializers=process.argv.includes('--compiled-initializers')
const nativeUTF8=process.argv.includes('--native-utf8')
const nativeUTF8Buffer=process.argv.includes('--native-utf8-buffer')
if(nativeUTF8Buffer&&!nativeUTF8)throw Error('Native UTF-8 Buffer operations require --native-utf8')
const guestSampling=process.argv.includes('--guest-sampling')
const wasmMemoryDiagnostics=process.argv.includes('--wasm-memory-diagnostics')
if(simd&&!guestWasm)throw Error('SIMD candidate requires --wasm')
const vmModules = process.argv.includes('--vm-modules')
const wasmTrampoline=process.argv.includes('--wasm-trampoline')
const batchArgument=process.argv.find(x=>x.startsWith('--wasm-dispatch-batch='))
const dispatchBatch=Number(batchArgument?.split('=')[1]??1)
if(![1,8,16,32].includes(dispatchBatch)||(batchArgument&&!wasmTrampoline&&!process.argv.includes('--cooperative')))throw Error('Dispatch batch requires a trampoline engine')
if(dispatchBatch>16&&!process.argv.includes('--dispatch-unwind'))throw Error('Larger dispatch batches require dispatch unwind')
if(wasmTrampoline&&(!guestWasm||process.argv.includes('--asyncify')))throw Error('WASM trampoline comparison requires synchronous --wasm')
const pollArgument=process.argv.slice(2).find(x=>x.startsWith('--wasm-poll='))
const wasmPoll=Number(pollArgument?.slice(12)??256)
if(![256,1024,4096].includes(wasmPoll)||(pollArgument&&!guestWasm))throw Error('Expected --wasm with --wasm-poll=256, 1024, or 4096')
const noInline = process.argv.includes('--no-inline')
const oneCallerInlineArgument=process.argv.slice(2).find(x=>x.startsWith('--binaryen-one-caller-inline-max='))
const oneCallerInlineMax=oneCallerInlineArgument===undefined?undefined:Number(oneCallerInlineArgument.slice(oneCallerInlineArgument.indexOf('=')+1))
if(oneCallerInlineMax!==undefined&&oneCallerInlineMax!==50)throw Error('Expected --binaryen-one-caller-inline-max=50')
const iterativeCalls = process.argv.includes('--iterative-calls')
const splitInterpreterProperties = process.argv.includes('--split-interpreter-properties')
const segmentedInterpreter = process.argv.includes('--segment-interpreter')
const batchedSegmentedInterpreter = process.argv.includes('--segment-interpreter-batched')
if(segmentedInterpreter&&batchedSegmentedInterpreter)throw Error('Choose one segmented interpreter implementation')
const anySegmentedInterpreter=segmentedInterpreter||batchedSegmentedInterpreter
if(anySegmentedInterpreter&&!iterativeCalls)throw Error('Segmented interpreter requires iterative calls')
if(anySegmentedInterpreter&&splitInterpreterProperties)throw Error('Choose one interpreter segmentation stage')
const moduleImportExports = process.argv.includes('--module-import-exports')
const generatorResume = process.argv.includes('--generator-resume')
if(generatorResume&&!iterativeCalls)throw Error('Generator resume continuations require iterative calls')
const atomics = process.argv.includes('--atomics')
const cooperative = process.argv.includes('--cooperative')
const fibers = process.argv.includes('--fibers')
const fiberFairness=process.argv.includes('--fiber-fairness')
if(fiberFairness&&!fibers)throw Error('Fiber fairness requires --fibers')
if(guestSampling&&(!fibers||fiberFairness||cooperative))throw Error('Guest sampling requires fibers without fairness or cooperative yielding')
if(sortDiagnostics&&!fibers)throw Error('Sort diagnostics require the fiber candidate')
const sharedStorage = process.argv.includes('--shared-storage')
if(wasmMemoryDiagnostics&&(!guestWasm||!sharedStorage||!fibers))throw Error('WASM memory diagnostics require --wasm --shared-storage --fibers')
if(sharedStorage&&(!fibers||!atomics||!process.argv.includes('--asyncify')))throw Error('Shared storage candidate requires --asyncify --fibers --atomics')
if(fibers&&(!process.argv.includes('--asyncify')||cooperative))throw Error('Fiber candidate requires --asyncify without --cooperative')
const splitNative = process.argv.includes('--split-native-calls')
const generatorQueue = process.argv.includes('--generator-queue')
const profileYields = process.argv.includes('--profile-yields')
const assignmentParser = process.argv.includes('--iterative-assignments')
const dispatchUnwind = process.argv.includes('--dispatch-unwind')
const heapLoops = process.argv.includes('--heap-loops')
if(heapLoops&&!dispatchUnwind)throw Error('Heap loops require dispatch unwind')
if(dispatchUnwind&&(!guestWasm||(!cooperative&&!wasmTrampoline)))throw Error('Dispatch unwind requires a WASM trampoline')
if(profileYields&&!cooperative)throw Error('Yield profiling requires the cooperative candidate')
if(cooperative&&!process.argv.includes('--asyncify'))throw Error('Cooperative candidate requires Asyncify')
if (guestWasm && process.argv.includes('--asyncify')&&!cooperative&&!fibers) throw Error('Guest WASM Asyncify requires a cooperative or fiber candidate')
const args = process.argv.slice(2).filter(x=>x!=='--asyncify'&&x!=='--wasm'&&x!=='--no-inline'&&x!=='--iterative-calls'&&x!=='--split-interpreter-properties'&&x!=='--generator-resume'&&x!=='--atomics'&&x!=='--cooperative'&&x!=='--split-native-calls'&&x!=='--generator-queue'&&x!=='--profile-yields'&&x!==optimizationArgument)
if(segmentedInterpreter)args.splice(args.indexOf('--segment-interpreter'),1)
if(batchedSegmentedInterpreter)args.splice(args.indexOf('--segment-interpreter-batched'),1)
if(oneCallerInlineArgument)args.splice(args.indexOf(oneCallerInlineArgument),1)
if(vmModules)args.splice(args.indexOf('--vm-modules'),1)
if(pollArgument)args.splice(args.indexOf(pollArgument),1)
if(wasmTrampoline)args.splice(args.indexOf('--wasm-trampoline'),1)
if(batchArgument)args.splice(args.indexOf(batchArgument),1)
if(assignmentParser)args.splice(args.indexOf('--iterative-assignments'),1)
if(dispatchUnwind)args.splice(args.indexOf('--dispatch-unwind'),1)
if(heapLoops)args.splice(args.indexOf('--heap-loops'),1)
if(fibers)args.splice(args.indexOf('--fibers'),1)
if(fiberFairness)args.splice(args.indexOf('--fiber-fairness'),1)
if(guestSampling)args.splice(args.indexOf('--guest-sampling'),1)
if(sharedStorage)args.splice(args.indexOf('--shared-storage'),1)
if(simd)args.splice(args.indexOf('--simd'),1)
if(lazyWasm)args.splice(args.indexOf('--lazy-wasm'),1)
if(sortDiagnostics)args.splice(args.indexOf('--sort-diagnostics'),1)
if(initializerProbe)args.splice(args.indexOf('--initializer-probe'),1)
if(compiledInitializers)args.splice(args.indexOf('--compiled-initializers'),1)
if(moduleImportExports)args.splice(args.indexOf('--module-import-exports'),1)
if(wasmMemoryDiagnostics)args.splice(args.indexOf('--wasm-memory-diagnostics'),1)
if(nativeUTF8)args.splice(args.indexOf('--native-utf8'),1)
if(nativeUTF8Buffer)args.splice(args.indexOf('--native-utf8-buffer'),1)
const source = resolve(args[0] ?? '.toolchains/quickjs-emscripten')
const emcc = resolve(args[1] ?? '.toolchains/emsdk/upstream/emscripten/emcc')
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim()
if (revision !== 'df4efb9ef2cb25c417ecb57986da462d11b244ed') throw new Error('Wrong source revision')
const patchPath = resolve('patches/quickjs-engine.patch')
const patch = readFileSync(patchPath)
const currentPatch = execFileSync('git', ['diff', '--', 'vendor/quickjs/quickjs.c'], { cwd: source })
if (currentPatch.length === 0) {
  execFileSync('git', ['apply', '--check', patchPath], { cwd: source })
  execFileSync('git', ['apply', patchPath], { cwd: source })
} else if (!currentPatch.equals(patch)) throw new Error('Engine source differs from the recorded engine patch')
const normalizerPatchPath=resolve('patches/quickjs-module-normalizer-error.patch')
const normalizerPatch=readFileSync(normalizerPatchPath)
const currentNormalizerPatch=execFileSync('git',['diff','--','c/interface.c'],{cwd:source})
if(!currentNormalizerPatch.length){
  execFileSync('git',['apply','--check',normalizerPatchPath],{cwd:source})
  execFileSync('git',['apply',normalizerPatchPath],{cwd:source})
}else if(!currentNormalizerPatch.equals(normalizerPatch))throw Error('Engine wrapper differs from the recorded module-normalizer patch')
const sdk = execFileSync(emcc, ['--version'], { encoding: 'utf8' })
if (!sdk.includes('5.0.1')) throw new Error('Expected Emscripten 5.0.1')
const asyncify = process.argv.includes('--asyncify')
const wrapperPatch = asyncify ? readFileSync('patches/quickjs-async-job-drain.patch') : undefined
const disposalPatch = asyncify ? readFileSync('patches/quickjs-async-dispose.patch') : undefined
if(disposalPatch){
  const current=execFileSync('git',['diff','--','packages/quickjs-emscripten-core/src/module-asyncify.ts'],{cwd:source})
  const path=resolve('patches/quickjs-async-dispose.patch')
  if(!current.length){execFileSync('git',['apply','--check',path],{cwd:source});execFileSync('git',['apply',path],{cwd:source})}
  else if(!current.equals(disposalPatch))throw new Error('Wrapper differs from recorded disposal patch')
}
if (wrapperPatch) {
  const current = execFileSync('git',['diff','--','packages/quickjs-emscripten-core/src/runtime-asyncify.ts'],{cwd:source})
  const path = resolve('patches/quickjs-async-job-drain.patch')
  if (!current.length) {
    execFileSync('git',['apply','--check',path],{cwd:source})
    execFileSync('git',['apply',path],{cwd:source})
  } else if (!current.equals(wrapperPatch)) throw new Error('Wrapper differs from the recorded async job-drain patch')
}
const baseOut = resolve((asyncify ? 'public/quickjs-als-asyncify'+(guestWasm?'-wasm':'') : guestWasm ? 'public/quickjs-als-wasm' : 'public/quickjs-als')+(optimizationArgument?'-'+optimization.toLowerCase():'')+(atomics?'-atomics':'')+(splitNative?'-split-native':'')+(splitInterpreterProperties?'-split-properties':'')+(segmentedInterpreter?'-interpreter-machine':'')+(batchedSegmentedInterpreter?'-interpreter-machine-batched':'')+(oneCallerInlineMax!==undefined?'-one-caller'+oneCallerInlineMax:'')+(generatorQueue?'-generator-queue':'')+(profileYields?'-yield-profile':'')+(pollArgument?'-poll'+wasmPoll:'')+(cooperative?'-cooperative':'')+(wasmTrampoline?'-trampoline':'')+(batchArgument?'-batch'+dispatchBatch:'')+(assignmentParser?'-assignments':'')+(dispatchUnwind?'-unwind':'')+(heapLoops?'-heap-loops':'')+(generatorResume?'-generator-resume':'')+(vmModules?'-vm-modules':'')+(fibers?'-fibers':'')+(sharedStorage?'-shared-storage':''))
const out=baseOut+(simd?'-simd':'')+(lazyWasm?'-lazy-wasm':'')+(wasmMemoryDiagnostics?'-memory-diagnostics':'')+(sortDiagnostics?'-sort-diagnostics':'')+(fiberFairness?'-fiber-fairness':'')+(initializerProbe?'-initializer-probe':'')+(compiledInitializers?'-compiled-initializers':'')+(fibers&&iterativeCalls?'-iterative-calls':'')+(moduleImportExports?'-module-import-exports':'')+(nativeUTF8?'-native-utf8':'')+(nativeUTF8Buffer?'-buffer':'')+(guestSampling?'-guest-sampling':'')
mkdirSync(out, { recursive: true })
// Assertions-enabled Asyncify builds need the upstream debug bindings, whose
// MaybeAsync entry points pass {async:true} to Emscripten cwrap.
const ffiPath = asyncify ? join(source,'packages/variant-quickjs-wasmfile-debug-asyncify/src/ffi.ts')
  : 'node_modules/@jitl/quickjs-wasmfile-release-sync/dist/ffi.mjs'
const ffi = readFileSync(ffiPath, 'utf8')
const exports = [...new Set([...ffi.matchAll(/\.cwrap\(\s*"(QTS_\w+)"/g)].map(x => '_' + x[1]))]
const fiberExports=fibers?['InitializeFiber','FiberCreate','FiberCreateEval','FiberStep','FiberStatus','FiberDeliver','FiberCancel','FiberTakeResult','FiberDispose'].map(name=>'_QTS_'+name):[]
if(sortDiagnostics)fiberExports.push('_QJS_SortDiagnosticGet')
if(guestSampling)fiberExports.push('_QJS_GuestSamplingReset','_QJS_GuestSamplingCount','_QJS_GuestSamplingRead','_QJS_GuestSamplingText')
if(initializerProbe)fiberExports.push('_QTS_ProbeCompiledInitializer')
if(compiledInitializers)fiberExports.push('_QTS_CompileTrustedInitializer','_QTS_CompileTrustedInitializerWithFilename','_QTS_EvalTrustedInitializer')
if(wasmMemoryDiagnostics)fiberExports.push('_QWasm_MemoryDiagnosticGet')
if(guestWasm)fiberExports.push('_QTS_WasmModuleSourceInfo')
// The one-shot stage observer requires uninterrupted begin/op0/end execution.
// Yielding candidates retain the existing inclusive operation observer only.
if(guestWasm&&!cooperative&&!fiberFairness)fiberExports.push('_QTS_WasmModuleTimingReset','_QTS_WasmModuleTimingRead')
if(sharedStorage)fiberExports.push('_QTS_ConfigureSharedStorage','_QTS_ConfigureSharedStorageReservation','_QTS_SharedClone','_QTS_SharedStats','_QTS_SharedRetain','_QTS_SharedAdopt','_QTS_SharedRelease')
if(sharedStorage&&guestWasm)fiberExports.push('_QTS_SharedWasmRetain','_QTS_SharedWasmAdopt','_QTS_SharedWasmRelease')
if(sharedStorage)fiberExports.push('_QTS_FiberAtomicPending','_QTS_FiberAtomicTimeout','_QTS_FiberAtomicReady')
writeFileSync(join(out, 'symbols.json'), JSON.stringify([...exports, ...fiberExports, '_QTS_InitializeInspection', '_QTS_InitializeCrypto', '_QTS_InitializeTermination', '_malloc', '_free']))
let qjs = join(source, 'vendor/quickjs')
const stacktraceDirectory=mkdtempSync(join(tmpdir(),'quickjs-stacktrace-'))
cpSync(qjs,join(stacktraceDirectory,'quickjs'),{recursive:true})
qjs=join(stacktraceDirectory,'quickjs')
copyFileSync('src/sandbox/guest-stacktrace.c',join(qjs,'qjs-stacktrace.h'))
execFileSync('patch',['-p1','-d',stacktraceDirectory,'-i',resolve('patches/quickjs-stacktrace.patch')],{stdio:'inherit'})
const allocationSafetyPatches=['quickjs-scope-resolution-oom.patch','quickjs-bound-function-oom.patch']
for(const name of allocationSafetyPatches)execFileSync('patch',['-p1','-d',stacktraceDirectory,'-i',resolve('patches',name)],{stdio:'inherit'})
const sharedAllocationPatches=['quickjs-autoinit-allocation.patch','quickjs-backtrace-ownership.patch']
for(const name of sharedAllocationPatches)execFileSync('patch',['-p1','-d',stacktraceDirectory,'-i',resolve('patches',name)],{stdio:'inherit'})
const languagePatches=['quickjs-disposal-symbols.patch']
for(const name of languagePatches)execFileSync('patch',['-p1','-d',stacktraceDirectory,'-i',resolve('patches',name)],{stdio:'inherit'})
stageConstructorMetadata(join(qjs,'quickjs.c'))
stageCallDepth(join(qjs,'quickjs.c'))
stageJobPump(join(qjs,'quickjs.c'))
stageSourcePositionCache(join(qjs,'quickjs.c'))
stageOpcodePatterns(join(qjs,'quickjs.c'))
if(splitInterpreterProperties)stageInterpreterProperties(join(qjs,'quickjs.c'))
if(iterativeCalls)stageInterpreterFrames(join(qjs,'quickjs.c'))
if(segmentedInterpreter)stageInterpreterMachine(join(qjs,'quickjs.c'))
if(batchedSegmentedInterpreter)stageBatchedInterpreterMachine(join(qjs,'quickjs.c'))
if(generatorResume)stageGeneratorResume(join(qjs,'quickjs.c'))
if(splitNative)stageNativeDispatch(join(qjs,'quickjs.c'))
if(generatorQueue)stageAsyncGeneratorQueue(join(qjs,'quickjs.c'))
stageProcessTermination(join(qjs,'quickjs.c'))
if(assignmentParser)stageAssignmentParser(join(qjs,'quickjs.c'))
if(vmModules)stageVMModuleRuntime(join(qjs,'quickjs.c'))
stageRequireESM(join(qjs,'quickjs.c'))
if(moduleImportExports)stageModuleImportExports(join(qjs,'quickjs.c'))
if(nativeUTF8)stageNativeUTF8(join(qjs,'quickjs.c'))
if(nativeUTF8Buffer){
  const {stageNativeUTF8Buffer}=await import('./stage-native-utf8-buffer.mjs')
  stageNativeUTF8Buffer(join(qjs,'quickjs.c'))
}
copyFileSync('src/sandbox/guest-inspect.c',join(qjs,'qjs-inspect.h'))
copyFileSync('src/sandbox/guest-crypto-native.c',join(qjs,'qjs-crypto.h'))
writeFileSync(join(qjs,'quickjs.c'),readFileSync(join(qjs,'quickjs.c'),'utf8')+'\n#include "qjs-inspect.h"\n#include "qjs-crypto.h"\n')
let interfaceFile = join(stacktraceDirectory, 'interface.c')
const originalInterface=readFileSync(join(source,'c/interface.c'),'utf8').replaceAll('../vendor/quickjs/','')
const usageMarker='  JS_SetPropertyStr(ctx, result, "malloc_limit", JS_NewInt64(ctx, s.malloc_limit));'
if(originalInterface.split(usageMarker).length!==2)throw Error('Unexpected memory-reporting source')
writeFileSync(interfaceFile,originalInterface.replace(usageMarker,usageMarker+'\n  JS_SetPropertyStr(ctx, result, "malloc_size", JS_NewInt64(ctx, s.malloc_size));'))
if(cooperative)writeFileSync(interfaceFile,stageCooperativeInterrupt(readFileSync(interfaceFile,'utf8'),profileYields))
writeFileSync(interfaceFile,readFileSync(interfaceFile,'utf8')+`
extern JSValue QJS_NewInspection(JSContext *ctx);
extern JSValue QJS_NewCrypto(JSContext *ctx);
extern JSValue QJS_NewTermination(JSContext *ctx);
JSValue *QTS_InitializeTermination(JSContext *ctx, JSValueConst *initializer) {
  if (!JS_IsFunction(ctx, *initializer))
    return jsvalue_to_heap(JS_ThrowTypeError(ctx, "Expected trusted termination initializer"));
  JSValue binding = QJS_NewTermination(ctx);
  if (JS_IsException(binding)) return jsvalue_to_heap(binding);
  JSValue result = JS_Call(ctx, *initializer, JS_UNDEFINED, 1, &binding);
  JS_FreeValue(ctx, binding);
  return jsvalue_to_heap(result);
}
JSValue *QTS_InitializeCrypto(JSContext *ctx, JSValueConst *initializer) {
  if (!JS_IsFunction(ctx, *initializer))
    return jsvalue_to_heap(JS_ThrowTypeError(ctx, "Expected trusted crypto initializer"));
  JSValue binding = QJS_NewCrypto(ctx);
  if (JS_IsException(binding)) return jsvalue_to_heap(binding);
  JSValue result = JS_Call(ctx, *initializer, JS_UNDEFINED, 1, &binding);
  JS_FreeValue(ctx, binding);
  return jsvalue_to_heap(result);
}
JSValue *QTS_InitializeInspection(JSContext *ctx, JSValueConst *initializer) {
  if (!JS_IsFunction(ctx, *initializer))
    return jsvalue_to_heap(JS_ThrowTypeError(ctx, "Expected trusted inspection initializer"));
  JSValue binding = QJS_NewInspection(ctx);
  if (JS_IsException(binding)) return jsvalue_to_heap(binding);
  JSValue result = JS_Call(ctx, *initializer, JS_UNDEFINED, 1, &binding);
  JS_FreeValue(ctx, binding);
  return jsvalue_to_heap(result);
}
`)
if(compiledInitializers)writeFileSync(interfaceFile,readFileSync(interfaceFile,'utf8')+'\n'+readFileSync('src/sandbox/trusted-initializer.c','utf8'))
let wasmBuild,wasmStagingDirectory
const wasmSources = [], wasmFlags = []
let memoryDiagnosticFiles
if (guestWasm) {
  const upstream = resolve('.toolchains/wasm3')
  const expected = '5fe766c933c7595d728d6172bb1a197607d85b4e'
  if (execFileSync('git',['rev-parse','HEAD'],{cwd:upstream,encoding:'utf8'}).trim() !== expected || execFileSync('git',['status','--porcelain'],{cwd:upstream,encoding:'utf8'}).trim()) throw Error('Unexpected Wasm3 source')
  const directory = mkdtempSync(join(tmpdir(), 'quickjs-guest-wasm-'))
  wasmStagingDirectory=directory
  cpSync(join(upstream,'source'),join(directory,'source'),{recursive:true})
  const patches = ['wasm3-frame-budget.patch','wasm3-export-validation.patch','wasm3-guest-ownership.patch','wasm3-allocation-ownership.patch','wasm3-reentrant-stack.patch','wasm3-host-memory.patch','wasm3-iterative-blocks.patch','wasm3-table-zero-maximum.patch','wasm3-table-references.patch','wasm3-host-budget.patch','wasm3-validator-diagnostics.patch']
  for (const patch of patches) execFileSync('patch',['-p1','-d',directory,'-i',resolve('patches',patch)],{stdio:'inherit'})
  stageValidatorControl(join(directory,'source'))
  stageValidatorLocation(join(directory,'source'))
  stageLocalReferenceBoundary(join(directory,'source'))
  stageGasCostRead(join(directory,'source'))
  stageWasmStackDiagnostics(join(directory,'source'))
  if(sharedStorage)stageSharedWasmMemory(join(directory,'source'))
  if(sharedStorage)stageWasmAtomics(join(directory,'source'))
  if(cooperative||wasmTrampoline||fibers)stageWasmDispatch(join(directory,'source'),dispatchBatch,dispatchUnwind,heapLoops)
  if(simd){
    const {stageVectorFoundation}=await import('./stage-wasm-simd.mjs')
    const {stageSIMDOps}=await import('./stage-wasm-simd-ops.mjs')
    stageVectorFoundation(join(directory,'source'))
    stageSIMDOps(join(directory,'source'))
  }
  if(lazyWasm){
    const {stageWasmLazyCompilation}=await import('./stage-wasm-lazy-compilation.mjs')
    stageWasmLazyCompilation(join(directory,'source'))
    wasmFlags.push('-DQWASM_LAZY_COMPILATION=1')
  }
  cpSync(qjs,join(directory,'quickjs'),{recursive:true}); qjs = join(directory,'quickjs')
  for (const name of ['quickjs-weakmap-ephemerons.patch']) {
    patches.push(name)
    execFileSync('patch',['-p1','-d',directory,'-i',resolve('patches',name)],{stdio:'inherit'})
  }
  const qjsFile = join(qjs,'quickjs.c')
  let qjsSource=readFileSync(qjsFile,'utf8')
  const replaceOnce=(from,to)=>{if(qjsSource.split(from).length!==2)throw Error('Unexpected QuickJS WASM integration site');qjsSource=qjsSource.replace(from,to)}
  replaceOnce('    uint8_t shared; /* if shared, the array buffer cannot be detached */','    uint8_t shared; /* if shared, the array buffer cannot be detached */\n    uint8_t wasm_owned; /* only the owning WASM memory may detach it */')
  replaceOnce('    abuf->shared = (class_id == JS_CLASS_SHARED_ARRAY_BUFFER);','    abuf->shared = (class_id == JS_CLASS_SHARED_ARRAY_BUFFER);\n    abuf->wasm_owned = 0;')
  replaceOnce('    pmax_len = NULL;\n    if (!transfer_to_fixed_length)', '    if (abuf->wasm_owned)\n        return JS_ThrowTypeError(ctx, "cannot transfer WebAssembly memory");\n    pmax_len = NULL;\n    if (!transfer_to_fixed_length)')
  qjsSource+='\nint QJS_WasmCheckInterrupt(JSContext *ctx) { return __js_poll_interrupts(ctx); }\nint QJS_WasmHasInterruptHandler(JSContext *ctx) { return ctx->rt->interrupt_handler != NULL; }\nvoid QJS_MarkWasmBuffer(JSValueConst obj) { JSArrayBuffer *b = JS_GetOpaque(obj, JS_CLASS_ARRAY_BUFFER); if (b) b->wasm_owned = 1; }\n'
  writeFileSync(qjsFile,qjsSource)
  const original = readFileSync(interfaceFile,'utf8')
  const marker = '  if (host_ref_class_init(JS_GetRuntime(ctx)) != 0) {'
  if (original.split(marker).length !== 2) throw Error('Unexpected context initialization source')
  interfaceFile = join(directory,'interface.c')
  writeFileSync(interfaceFile,original.replace(marker,'  extern int QJS_InstallWasm(JSContext *ctx);\n  if (QJS_InstallWasm(ctx)) { JS_FreeContext(ctx); return NULL; }\n'+marker))
  const guestWasmFile=wasmMemoryDiagnostics?join(directory,'guest-wasm.c'):resolve('src/sandbox/guest-wasm.c')
  if(wasmMemoryDiagnostics){
    copyFileSync(resolve('src/sandbox/guest-wasm.c'),guestWasmFile)
    memoryDiagnosticFiles={guestWasmFile,wasm3Directory:join(directory,'source')}
  }
  wasmSources.push(guestWasmFile,...readdirSync(join(directory,'source')).filter(x=>x.endsWith('.c')).map(x=>join(directory,'source',x)))
  wasmFlags.push('-g2','-I'+qjs,'-I'+join(source,'c'),'-I'+join(directory,'source'),'-DQJS_GUEST_WASM=1',...(cooperative||wasmTrampoline||fibers?['-DM3_HAS_TAIL_CALL=0','-Dd_m3PreloadNextOp=0','-Dd_m3CanTailCall=1']:['-mtail-call']),'-Dd_m3MaxLinearMemoryPages=1024','-Dd_m3MaxNativeStack=131072','-Dd_m3HasExceptionHandling=0')
  wasmBuild = {revision:expected,patches:Object.fromEntries(patches.map(name=>[name,createHash('sha256').update(readFileSync(resolve('patches',name))).digest('hex')])),bridgeSHA256:createHash('sha256').update(readFileSync('src/sandbox/guest-wasm.c')).digest('hex'),quickjsSourceSHA256:createHash('sha256').update(qjsSource).digest('hex'),bootstrapSHA256:createHash('sha256').update(readFileSync('src/sandbox/guest-wasm.js')).digest('hex'),allocation:'QuickJS runtime allocator',stagingDirectoryRetained:false}
  wasmBuild.executionBudget = 'Host interrupt handler when installed; otherwise 1000000 gas per top-level WASM call. Poll instrumentation always enabled.'
  if(lazyWasm)wasmBuild.lazyCompilation={experimental:true,stageSHA256:createHash('sha256').update(readFileSync('scripts/stage-wasm-lazy-compilation.mjs')).digest('hex'),validation:'eager'}
  wasmBuild.dispatchBatch=dispatchBatch
  wasmBuild.dispatchUnwind=dispatchUnwind
  wasmBuild.heapLoops=heapLoops
  if(cooperative||wasmTrampoline||fibers)wasmBuild.cooperativeDispatchSHA256=createHash('sha256').update(readFileSync('scripts/stage-wasm-dispatch.mjs')).digest('hex')
  if(fibers)wasmBuild.fiberStateHeaderSHA256=createHash('sha256').update(readFileSync('src/sandbox/guest-wasm-fiber.h')).digest('hex')
  if(sharedStorage)wasmBuild.sharedMemoryStageSHA256=createHash('sha256').update(readFileSync('scripts/stage-shared-wasm-memory.mjs')).digest('hex')
  if(sharedStorage)wasmBuild.atomicStageSHA256=createHash('sha256').update(readFileSync('scripts/stage-wasm-atomics.mjs')).digest('hex')
  wasmBuild.validatorControlSHA256 = createHash('sha256').update(readFileSync('scripts/stage-validator-control.mjs')).digest('hex')
  wasmBuild.validatorLocationSHA256 = createHash('sha256').update(readFileSync('scripts/stage-validator-location.mjs')).digest('hex')
  if(simd)wasmBuild.simd={experimental:true,foundationSHA256:createHash('sha256').update(readFileSync('scripts/stage-wasm-simd.mjs')).digest('hex'),operationsSHA256:createHash('sha256').update(readFileSync('scripts/stage-wasm-simd-ops.mjs')).digest('hex')}
  wasmBuild.localReferenceBoundarySHA256 = createHash('sha256').update(readFileSync('scripts/stage-local-reference-boundary.mjs')).digest('hex')
  wasmBuild.gasCostReadSHA256 = createHash('sha256').update(readFileSync('scripts/stage-gas-cost-read.mjs')).digest('hex')
  wasmBuild.stackDiagnosticsSHA256 = createHash('sha256').update(readFileSync('scripts/stage-wasm-stack-diagnostics.mjs')).digest('hex')
  copyFileSync(join(upstream,'LICENSE'),join(out,'WASM3-LICENSE'))
}
const version = readFileSync(join(qjs, 'VERSION'), 'utf8').trim()
if(sharedStorage){
  stageSharedBufferViews(qjs)
  const filename=join(qjs,'quickjs.c'),original=readFileSync(filename,'utf8')
  const failed='            if (!abuf->data)\n                goto fail;\n            memset(abuf->data, 0, sab_alloc_len);'
  if(original.split(failed).length!==2)throw Error('Unexpected shared allocator failure site')
  writeFileSync(filename,original.replace(failed,'            if (!abuf->data) {\n                JS_ThrowOutOfMemory(ctx);\n                goto fail;\n            }\n            memset(abuf->data, 0, sab_alloc_len);')+`
int QJS_FixedSharedBuffer(JSContext *ctx, JSValueConst value, uint8_t **bytes, size_t *length) {
  (void)ctx;
  if (JS_VALUE_GET_TAG(value)!=JS_TAG_OBJECT) return 0;
  JSObject *object=JS_VALUE_GET_OBJ(value);
  if (object->class_id!=JS_CLASS_SHARED_ARRAY_BUFFER) return 0;
  JSArrayBuffer *buffer=object->u.array_buffer;
  if (!buffer || buffer->detached || !buffer->shared || buffer->max_byte_length!=-1) return 0;
  *bytes=buffer->data; *length=buffer->byte_length; return 1;
}
`)
  const staged=readFileSync(interfaceFile,'utf8'),runtime='JSRuntime *QTS_NewRuntime() {\n  return JS_NewRuntime();\n}'
  if(staged.split(runtime).length!==2)throw Error('Unexpected shared storage runtime initialization site')
  writeFileSync(interfaceFile,staged.replace(runtime,
    'static void qts_install_shared_storage(JSRuntime *runtime);\nJSRuntime *QTS_NewRuntime() {\n  JSRuntime *runtime=JS_NewRuntime();\n  if (runtime) qts_install_shared_storage(runtime);\n  return runtime;\n}')+'\n'+readFileSync('src/sandbox/guest-shared-storage.c','utf8'))
}
if(guestWasm){
  writeFileSync(interfaceFile,readFileSync(interfaceFile,'utf8')+`
extern double QWasm_ModuleSourceInfo(JSContext *, JSValueConst, int);
extern void QWasm_ModuleTimingReset(int);
extern double QWasm_ModuleTimingRead(int);
void QTS_WasmModuleTimingReset(int enabled) { QWasm_ModuleTimingReset(enabled); }
double QTS_WasmModuleTimingRead(int field) { return QWasm_ModuleTimingRead(field); }
double QTS_WasmModuleSourceInfo(JSContext *ctx, JSValue *value, int field) {
  return QWasm_ModuleSourceInfo(ctx, *value, field);
}
`)
}
if(sharedStorage&&guestWasm){
  writeFileSync(interfaceFile,readFileSync(interfaceFile,'utf8')+`
extern JSValue QWasm_RetainSharedMemory(JSContext *, JSValueConst);
extern JSValue QWasm_AdoptSharedMemory(JSContext *, int);
extern int QWasm_ReleaseSharedMemory(int);
JSValue *QTS_SharedWasmRetain(JSContext *ctx, JSValue *value) {
  return jsvalue_to_heap(QWasm_RetainSharedMemory(ctx, *value));
}
JSValue *QTS_SharedWasmAdopt(JSContext *ctx, int id) {
  return jsvalue_to_heap(QWasm_AdoptSharedMemory(ctx, id));
}
int QTS_SharedWasmRelease(int id) { return QWasm_ReleaseSharedMemory(id); }
`)
}
if(fibers){
  // Only this candidate exposes explicit stack-boundary preservation. Each
  // resumed fiber keeps its original allowance instead of resetting at park.
  writeFileSync(join(qjs,'quickjs.c'),readFileSync(join(qjs,'quickjs.c'),'utf8')+`
void QJS_FiberSaveStack(JSRuntime *rt, uintptr_t *bounds) {
  bounds[0]=rt->stack_top; bounds[1]=rt->stack_limit;
}
void QJS_FiberRestoreStack(JSRuntime *rt, const uintptr_t *bounds) {
  rt->stack_top=bounds[0]; rt->stack_limit=bounds[1];
}
`)
  const call='  JSValue *result_ptr = qts_host_call_function(ctx, &this_val, argc, argv, host_ref_id);'
  const staged=readFileSync(interfaceFile,'utf8')
  if(staged.split(call).length!==2)throw Error('Unexpected fiber host callback integration site')
  writeFileSync(interfaceFile,'static unsigned qts_fiber_host_callback_depth;\n'+staged.replace(call,
    '  qts_fiber_host_callback_depth++;\n'+call+'\n  qts_fiber_host_callback_depth--;')+'\n'+readFileSync('src/sandbox/guest-fiber-call.c','utf8'))
}
if(sortDiagnostics){
  const {stageSortDiagnostics}=await import('./stage-sort-diagnostics.mjs')
  stageSortDiagnostics(qjs)
}
if(fiberFairness){
  const {stageFiberFairness}=await import('./stage-fiber-fairness.mjs')
  stageFiberFairness(qjs,interfaceFile)
}
if(guestSampling){
  const {stageGuestSampling}=await import('./stage-guest-sampling.mjs')
  stageGuestSampling(join(qjs,'quickjs.c'))
}
if (asyncify) {
  if(sharedStorage)stageAtomicWait(join(qjs,'quickjs.c'))
  if(sharedStorage)stageSharedAtomicPointers(qjs)
  const interfaceSource = readFileSync(join(source, 'c/interface.c'), 'utf8')
  // Keep every path that can call guest JS instrumented. Only functions the
  // upstream wrapper labels synchronous are removed from Asyncify instrumentation.
  const declarations = [...interfaceSource.matchAll(/^([\w()* ]+[\s*]+)(QTS_\w+)(\((.*?)\)) ?\{/gm)]
  const remove = declarations.filter(m=>!m[1].includes('MaybeAsync')&&!m[1].includes('DebugOnly')&&!(fibers&&m[2]==='QTS_FiberStep')).map(m=>m[2])
  writeFileSync(join(out, 'asyncify-remove.json'), JSON.stringify(remove))
  writeFileSync(join(out, 'asyncify-imports.json'), JSON.stringify(['qts_host_call_function','qts_host_load_module_source','qts_host_normalize_module',...(cooperative?['qts_host_interrupt_handler']:[])]))
}
if(wasmMemoryDiagnostics){
  const {stageWasmMemoryDiagnostics}=await import('./stage-wasm-memory-diagnostics.mjs')
  stageWasmMemoryDiagnostics({...memoryDiagnosticFiles,sharedStorageFile:interfaceFile})
}
const compilerPrefixMaps=[
  ...(wasmStagingDirectory?[[wasmStagingDirectory,'/sources/wasm3-staged']]:[]),
  [stacktraceDirectory,'/sources/quickjs-staged'],
  [source,'/sources/quickjs-emscripten'],
  [resolve('.'),'/project'],
].flatMap(([from,to])=>[`-ffile-prefix-map=${from}=${to}`,`-fmacro-prefix-map=${from}=${to}`])
execFileSync(emcc, [
  '-DQWASM_INTERRUPT_INTERVAL='+wasmPoll,
  ...compilerPrefixMaps,
  interfaceFile,
  ...(initializerProbe?['-DQTS_INITIALIZER_PROBE_EXPORT',resolve('fixtures/compiled-initializer-probe.c')]:[]),
  ...wasmSources, ...wasmFlags,
  ...['quickjs', 'dtoa', 'libregexp', 'libunicode', 'cutils', 'quickjs-libc'].map(x => join(qjs, x + '.c')),
  '-I'+qjs, '-I'+join(source,'c'), '-I'+resolve('src/sandbox'),
  '-D_GNU_SOURCE', '-DCONFIG_STACK_CHECK', `-DCONFIG_VERSION="${version}"`,
  ...(atomics?['-DCONFIG_ATOMICS']:[]),
  ...(sharedStorage?['-DQTS_SHARED_STORAGE']:[]),
  ...(fiberFairness?['-DQTS_FIBER_FAIRNESS']:[]),
  ...(guestSampling?['-DQJS_GUEST_SAMPLING']:[]),
  '-'+optimization, '-flto', '--no-entry', '-sMODULARIZE=1', '-sEXPORT_ES6=1',
  ...(noInline ? ['-fno-inline-functions','-sINLINING_LIMIT=1'] : []),
  // LLVM's noinline attribute does not constrain Binaryen's one-caller pass.
  // Keep the split interpreter body separate in this experimental build.
  ...(splitNative||oneCallerInlineMax!==undefined ? [`-sBINARYEN_EXTRA_PASSES=--one-caller-inline-max-function-size=${oneCallerInlineMax??50}`] : []),
  '-sEXPORT_NAME=QuickJSRaw', '-sENVIRONMENT=web,worker,node',
  '-sALLOW_MEMORY_GROWTH=1', '-sALLOW_TABLE_GROWTH=1', '-sSTACK_SIZE=5MB',
  '-sIMPORTED_MEMORY=1', '-sFILESYSTEM=0', '-sASSERTIONS=1',
  '-sEXPORTED_FUNCTIONS=@' + join(out, 'symbols.json'),
  '-sEXPORTED_RUNTIME_METHODS=@' + join(source, asyncify ? 'exportedRuntimeMethods.asyncify.json' : 'exportedRuntimeMethods.json'),
  ...(asyncify ? ['-sASYNCIFY=1', '-DQTS_ASYNCIFY=1', '-DQTS_DEBUG_MODE', '-DQTS_ASYNCIFY_DEFAULT_STACK_SIZE=262144',
    '-sASYNCIFY_STACK_SIZE=262144', '-sASYNCIFY_REMOVE=@'+join(out,'asyncify-remove.json'),
    '-sASYNCIFY_IMPORTS=@'+join(out,'asyncify-imports.json'), '-lasync.js'] : []),
  '--pre-js', join(source, 'templates/pre-extension.js'),
  '--pre-js', join(source, 'templates/pre-wasmMemory.js'),
  '-o', join(out, 'engine.mjs'),
], { stdio: 'inherit' })
const engineOutput=join(out,'engine.mjs')
const engineBundle=readFileSync(engineOutput,'utf8')
writeFileSync(engineOutput,normalizeCompilerSourcePaths(engineBundle,source))
if (asyncify) {
  await build({ entryPoints:[join(source,'packages/quickjs-emscripten-core/src/index.ts')],
    outfile:join(out,'core.mjs'),bundle:true,format:'esm',platform:'browser',target:'es2022',
    tsconfigRaw:{compilerOptions:{target:'ES2022',useDefineForClassFields:false}},nodePaths:[resolve('node_modules')],legalComments:'inline' })
  await build({entryPoints:[ffiPath],outfile:join(out,'ffi.mjs'),bundle:true,format:'esm',platform:'browser',
    target:'es2022',tsconfigRaw:{compilerOptions:{target:'ES2022',useDefineForClassFields:false}},nodePaths:[resolve('node_modules')]})
}
const inspectionWrapper=stageInspectionWrapper(source,stacktraceDirectory,{fibers,sharedStorage,guestWasm,compiledInitializers})
const inspectionOutput=join(out,'core.mjs')
const inspectionBuild=await build({entryPoints:[inspectionWrapper],outfile:inspectionOutput,bundle:true,format:'esm',platform:'browser',target:'es2022',metafile:true,
  tsconfigRaw:{compilerOptions:{target:'ES2022',useDefineForClassFields:false}},nodePaths:[resolve('node_modules')],legalComments:'inline'})
const inspectionBundle=readFileSync(inspectionOutput,'utf8')
const normalizedInspectionBundle=normalizeInspectionWrapperPaths(inspectionBundle,Object.keys(inspectionBuild.metafile.inputs),stacktraceDirectory)
writeFileSync(inspectionOutput,normalizedInspectionBundle)
copyFileSync(join(source, 'LICENSE'), join(out, 'WRAPPER-LICENSE'))
copyFileSync(join(qjs, 'LICENSE'), join(out, 'QUICKJS-LICENSE'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
writeFileSync(join(out, 'build.json'), JSON.stringify({ revision, sdk: '5.0.1', version,
  ...(nativeUTF8?{nativeUTF8:{
    stageSHA256:hash(readFileSync('scripts/stage-native-utf8.mjs')),
    bindingSHA256:hash(readFileSync('src/sandbox/guest-native-utf8.c')),
    intrinsic:'__qjsEncodeUTF8',operations:['encodeUTF8'],input:'string',output:'ArrayBuffer',
    allocation:'QuickJS runtime allocator, fresh guest-owned bytes',loneSurrogates:'U+FFFD',
    interruptPollCodeUnits:65536,maxOutputBytes:2147483647,
  }}:{}),
  ...(nativeUTF8Buffer?{nativeUTF8Buffer:{experimental:true,
    stageSHA256:hash(readFileSync('scripts/stage-native-utf8-buffer.mjs')),bindingSHA256:hash(readFileSync('src/sandbox/guest-native-utf8-buffer.c')),
    intrinsics:['__qjsUTF8ByteLength','__qjsWriteUTF8'],operations:['utf8ByteLength','writeUTF8'],input:'string',target:'Uint8Array',
    ranges:'strict view-relative integer offset and limit',loneSurrogates:'U+FFFD',partialCodePoints:false,interruptPollCodeUnits:65536,encodedOutputAllocation:false,
  }}:{}),
  ...(initializerProbe?{initializerProbe:{bindingSHA256:hash(readFileSync('fixtures/compiled-initializer-probe.c')),scope:'Candidate-only compiled initialization probe, no WorkerKernel integration'}}:{}),
  ...(compiledInitializers?{compiledInitializers:{bindingSHA256:hash(readFileSync('src/sandbox/trusted-initializer.c')),maxSourceBytes:2*1024*1024,maxCompiledBytes:8*1024*1024,scope:'Host-only same-engine initialization, no guest bytecode API'}}:{}),
  ...(wasmMemoryDiagnostics?{wasmMemoryDiagnostics:{enabled:true,stageSHA256:hash(readFileSync('scripts/stage-wasm-memory-diagnostics.mjs')),scope:'Candidate-only scalar memory growth counters, unchanged allocation policy',stagedBridgeSHA256:hash(readFileSync(memoryDiagnosticFiles.guestWasmFile))}}:{}),
  ...(sortDiagnostics?{sortDiagnostics:{stageSHA256:hash(readFileSync('scripts/stage-sort-diagnostics.mjs')),scope:'Source-level scalar diagnostics, unchanged sorting algorithm'}}:{}),
  termination:{stageSHA256:hash(readFileSync('scripts/stage-process-termination.mjs'))},
  requireESM:{stageSHA256:hash(readFileSync('scripts/stage-require-esm.mjs')),bindingSHA256:hash(readFileSync('src/sandbox/guest-require-esm.c'))},
  moduleImportExports:moduleImportExports?{stageSHA256:hash(readFileSync('scripts/stage-module-import-exports.mjs'))}:undefined,
  ...(guestSampling?{guestSampling:{experimental:true,maxSamples:512,intervalMs:20,functionBytes:96,filenameBytes:192,retention:'latest512',storage:'runtime-owned host allocation outside guest heap quota',maxStorageBytes:172064,stageSHA256:hash(readFileSync('scripts/stage-guest-sampling.mjs')),bindingSHA256:hash(readFileSync('src/sandbox/guest-sampling.c'))}}:{}),
  ...(assignmentParser?{assignmentParser:{stageSHA256:hash(readFileSync('scripts/stage-assignment-parser.mjs'))}}:{}),
  atomics,
  sharedStorageBudget:sharedStorage?{defaultBytes:16*1024*1024,maxSupportedBytes:1536*1024*1024,scope:'per outer engine, host-configured before first runtime, immutable thereafter',atomicPointerStageSHA256:hash(readFileSync('scripts/stage-shared-atomic-pointers.mjs'))}:undefined,
  sharedStorage:sharedStorage?{bindingSHA256:hash(readFileSync('src/sandbox/guest-shared-storage.c')),viewStageSHA256:hash(readFileSync('scripts/stage-shared-buffer-views.mjs')),headerSHA256:hash(readFileSync('src/sandbox/guest-shared-storage.h')),atomicWaitStageSHA256:hash(readFileSync('scripts/stage-atomic-wait.mjs')),buildStageSHA256:hash(readFileSync('scripts/build-quickjs-als.mjs')),maxBytes:16*1024*1024,maxAllocations:256,scope:guestWasm?'group-owned SAB and WASM memory, message leases and single-engine scheduler-owned atomic operations':'engine-owned fixed SAB storage, message leases and native scheduler-owned atomic waits; not shared WASM'}:undefined,
  fibers:fibers?{bindingSHA256:hash(readFileSync('src/sandbox/guest-fiber-call.c')),buildStageSHA256:hash(readFileSync('scripts/build-quickjs-als.mjs')),stackBytes:512*1024,quickJSStackBytes:384*1024,nativeHeadroomBytes:128*1024,scope:'experimental scheduler-owned QTS_Call and QTS_Eval continuations, not WASM threads',fairness:fiberFairness?{experimental:true,scope:'JavaScript bytecode branch polls only, outside native WASM operations and imported callbacks',wasmGuard:guestWasm,status:3,stageSHA256:hash(readFileSync('scripts/stage-fiber-fairness.mjs'))}:undefined}:undefined,
  cooperative:cooperative?{sliceMs:8,profileYields,wasmPoll,stageSHA256:hash(readFileSync('scripts/stage-cooperative-interrupt.mjs'))}:undefined,
  patchSha256: hash(patch), wasmSha256: hash(readFileSync(join(out, 'engine.wasm'))),
  stackTracePatchSHA256: hash(readFileSync('patches/quickjs-stacktrace.patch')),
  stackTraceSourceSHA256: hash(readFileSync('src/sandbox/guest-stacktrace.c')),
  allocationSafetyPatches:Object.fromEntries(allocationSafetyPatches.map(name=>[name,hash(readFileSync(resolve('patches',name)))])),
  sharedAllocationPatches:Object.fromEntries(sharedAllocationPatches.map(name=>[name,hash(readFileSync(resolve('patches',name)))])),
  languagePatches:Object.fromEntries(languagePatches.map(name=>[name,hash(readFileSync(resolve('patches',name)))])),
  inspection:{bindingSHA256:hash(readFileSync('src/sandbox/guest-inspect.c')),constructorMetadataSHA256:hash(readFileSync('scripts/stage-constructor-metadata.mjs')),wrapperStageSHA256:hash(readFileSync('scripts/stage-inspection-wrapper.mjs')),coreSHA256:hash(readFileSync(join(out,'core.mjs')))},
  crypto:{bindingSHA256:hash(readFileSync('src/sandbox/guest-crypto-native.c'))},
  guestCallDepth:{limit:guestCallDepthLimit,nativeReentryLimit:nativeReentryDepthLimit,stageSHA256:hash(readFileSync('scripts/stage-call-depth.mjs'))},
  interpreterFrames:iterativeCalls?{limit:4096,stageSHA256:hash(readFileSync('scripts/stage-interpreter-frames.mjs'))}:undefined,
  interpreterPropertyDispatch:splitInterpreterProperties?{stageSHA256:hash(readFileSync('scripts/stage-interpreter-properties.mjs')),scope:'property, reference and class bytecodes only'}:undefined,
  interpreterMachine:anySegmentedInterpreter?{stageSHA256:hash(readFileSync(segmentedInterpreter?'scripts/stage-interpreter-machine.mjs':'scripts/stage-interpreter-machine-batched.mjs')),...(batchedSegmentedInterpreter?{baseStageSHA256:hash(readFileSync('scripts/stage-interpreter-machine.mjs'))}:{}),variant:batchedSegmentedInterpreter?'persistent-state-family-runs':'single-opcode-family-dispatch',scope:'ordinary opcode families with coordinator-owned entry, calls, yields and unwind'}:undefined,
  binaryenOneCallerInlineMax:oneCallerInlineMax,
  generatorResume:generatorResume?{stageSHA256:hash(readFileSync('scripts/stage-generator-resume.mjs')),scope:'direct intrinsic generator calls'}:undefined,
  opcodePatterns:{stageSHA256:hash(readFileSync('scripts/stage-opcode-patterns.mjs'))},
  vmModules:vmModules?{stageSHA256:hash(readFileSync('scripts/stage-vm-module-compile.mjs')),dynamicImportStageSHA256:hash(readFileSync('scripts/stage-vm-dynamic-import.mjs')),bindingSHA256:hash(readFileSync('fixtures/vm-module-guest-native.inc')),guestAPISHA256:hash(readFileSync('src/sandbox/guest-vm-modules.js')),maxLiveHandles:32,maxCreatedHandles:4096,maxSourceBytes:1048576,maxSyntheticExports:128,maxPendingImports:32,maxImportBytecodes:4096,scope:'async module graphs and owned module or namespace dynamic import callbacks; no cached data'}:undefined,
  nativeDispatch:splitNative?{stageSHA256:hash(readFileSync('scripts/stage-native-dispatch.mjs')),binaryenOneCallerInlineMax:50}:undefined,
  generatorQueue:generatorQueue?{stageSHA256:hash(readFileSync('scripts/stage-async-generator-queue.mjs'))}:undefined,
  interfaceSourceSHA256:hash(readFileSync(interfaceFile)),
  normalizerPatchSha256: hash(normalizerPatch),
  wasmBytes: readFileSync(join(out, 'engine.wasm')).length,
  assertions: true, asyncLowering: false, optimization, noInline, guestScripts: true,
  sandboxContexts: true, contextCreationLimit: 64, nativeJobPump: true,
  jobPumpStageSHA256:hash(readFileSync('scripts/stage-job-pump.mjs')),
  sourcePositionCacheStageSHA256:hash(readFileSync('scripts/stage-source-position-cache.mjs')),
  allocatorAccounting: 'malloc_usable_size',
  asyncify, wrapperPatchSha256: wrapperPatch ? hash(wrapperPatch) : undefined,
  guestWasm: wasmBuild,
  disposalPatchSha256: disposalPatch ? hash(disposalPatch) : undefined,
}, null, 2) + '\n')
console.log('Built patched QuickJS with native async context:', out)
