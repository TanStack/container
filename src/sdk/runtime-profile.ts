import type {ExperimentalCompilerPolicy} from '../compiler/compiler-policy'
import type {RolldownParserPolicy} from '../compiler/rolldown-parser-policy'

const syncEngineSlots=['quickjs-als','quickjs-als-wasm'] as const
const fiberEngineSlots=['quickjs-als-asyncify-atomics-fibers-shared-storage','quickjs-als-asyncify-wasm-atomics-fibers-shared-storage'] as const
const fiberProfiles=new Set([
  'experimental-fibers','experimental-fibers-simd','experimental-fibers-simd-lazy',
  'experimental-fibers-simd-lazy-fairness','experimental-fibers-simd-lazy-initializers',
  'experimental-fibers-simd-lazy-initializers-o2','experimental-fibers-simd-lazy-initializers-o2-assignments',
  'experimental-fibers-simd-lazy-initializers-o2-iterative-calls',
  'experimental-fibers-simd-lazy-initializers-o2-iterative-calls-module-import-exports',
  'experimental-fibers-simd-lazy-initializers-o2-iterative-calls-module-import-exports-assignments',
  'experimental-fibers-simd-lazy-initializers-o2-iterative-calls-module-import-exports-assignments-cooperative-heap-loops',
  'experimental-fibers-simd-lazy-initializers-o2-iterative-calls-module-import-exports-assignments-cooperative-heap-loops-segmented-interpreter',
  'experimental-fibers-simd-lazy-initializers-o2-iterative-calls-module-import-exports-assignments-cooperative-heap-loops-segmented-interpreter-batched',
  'experimental-fibers-simd-lazy-initializers-o2-iterative-calls-module-import-exports-assignments-cooperative-heap-loops-segmented-interpreter-batched-native-utf8',
  'experimental-fibers-simd-lazy-initializers-o2-iterative-calls-module-import-exports-assignments-cooperative-heap-loops-segmented-interpreter-batched-native-utf8-buffer',
  'experimental-fibers-simd-lazy-initializers-o2-iterative-calls-module-import-exports-assignments-cooperative-heap-loops-segmented-interpreter-batched-native-utf8-guest-sampling',
])
const supportedProfiles=new Set(['default','sync-o2','sync-o2-vm-modules',...fiberProfiles])
const compilerPolicy=Object.freeze<ExperimentalCompilerPolicy>({maxMemoryPages:1024,timeoutMs:30000,lifetime:'session'})
const parserPolicy=Object.freeze<RolldownParserPolicy>({timeoutMs:30000,maxSourceBytes:16*1024*1024})
const isolationHeaders=Object.freeze({
  'Cross-Origin-Opener-Policy':'same-origin',
  'Cross-Origin-Embedder-Policy':'require-corp',
})
const noIsolationHeaders=Object.freeze({})

export type SDKRuntimeWorkload='vite'|'tanstack-start'
export interface SDKRuntimeKernelOptions {
  readonly cooperative:false
  readonly experimentalCompiler:Readonly<ExperimentalCompilerPolicy>
  readonly experimentalFibers?:true
  readonly experimentalRolldownParser?:Readonly<RolldownParserPolicy>
}
export interface SDKRuntimeProfile {
  readonly workload:SDKRuntimeWorkload
  readonly buildProfile:string
  readonly kernelOptions:Readonly<SDKRuntimeKernelOptions>
  readonly requiresCrossOriginIsolation:boolean
  readonly ownerHeaders:Readonly<Record<string,string>>
}
export interface SDKRuntimeEnvironment {
  readonly crossOriginIsolated:boolean
  readonly sharedArrayBuffer:boolean
}

function record(value:unknown,label:string):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('SDK manifest has invalid '+label)
  return value as Record<string,unknown>
}
function safeRuntimePath(value:unknown,label:string):string{
  if(typeof value!=='string'||!value.startsWith('runtime/')||value.includes('\\')||value.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('SDK manifest has invalid '+label)
  return value
}
function requireEngines(manifest:Record<string,unknown>,slots:readonly string[]){
  const engines=record(manifest.engines,'engine mappings')
  for(const slot of slots)if(!Object.hasOwn(engines,slot)||!engines[slot]||typeof engines[slot]!=='object'||Array.isArray(engines[slot]))throw Error('SDK manifest is missing engine '+slot)
}
function requireCompiler(manifest:Record<string,unknown>){
  const compiler=record(manifest.experimentalCompiler,'opt-in browser compiler artifact')
  if(compiler.enabledByDefault!==false)throw Error('SDK browser compiler must be opt-in')
  if(safeRuntimePath(compiler.worker,'browser compiler worker')!=='runtime/workers/browser-compiler.js'||safeRuntimePath(compiler.artifact,'browser compiler artifact')!=='runtime/compiler/artifact.json')throw Error('SDK manifest has unsupported browser compiler paths')
  if(typeof compiler.version!=='string'||!compiler.version||typeof compiler.runtimeSHA256!=='string'||!/^[a-f0-9]{64}$/.test(compiler.runtimeSHA256))throw Error('SDK manifest has invalid browser compiler provenance')
}
function requireParser(manifest:Record<string,unknown>){
  const parser=record(manifest.experimentalRolldownParser,'opt-in native parser artifact')
  if(parser.enabledByDefault!==false)throw Error('SDK native parser must be opt-in')
  const directory=safeRuntimePath(parser.directory,'native parser directory')
  const artifact=safeRuntimePath(parser.artifact,'native parser artifact')
  if(directory!=='runtime/rolldown-parser'||artifact!=='runtime/rolldown-parser/artifact.json'||typeof parser.version!=='string'||!parser.version)throw Error('SDK manifest has invalid native parser provenance')
}

/**
 * Resolve the owner-controlled runtime configuration proven for a packaged SDK.
 * The manifest is treated as untrusted input and unsupported profiles fail closed.
 */
export function resolveSDKRuntimeProfile(manifestValue:unknown,workload:SDKRuntimeWorkload):Readonly<SDKRuntimeProfile>{
  const manifest=record(manifestValue,'root')
  const profile=manifest.buildProfile
  if(typeof profile!=='string'||!supportedProfiles.has(profile))throw Error('Unsupported SDK build profile: '+String(profile))
  if(workload!=='vite'&&workload!=='tanstack-start')throw Error('Unsupported SDK runtime workload: '+String(workload))
  requireCompiler(manifest)
  if(workload==='vite'){
    requireEngines(manifest,syncEngineSlots)
    return Object.freeze({workload,buildProfile:profile,kernelOptions:Object.freeze({cooperative:false,experimentalCompiler:compilerPolicy}),requiresCrossOriginIsolation:false,ownerHeaders:noIsolationHeaders})
  }
  if(!fiberProfiles.has(profile))throw Error('TanStack Start requires a packaged experimental fiber profile')
  requireEngines(manifest,fiberEngineSlots)
  requireParser(manifest)
  return Object.freeze({workload,buildProfile:profile,kernelOptions:Object.freeze({cooperative:false,experimentalFibers:true,experimentalCompiler:compilerPolicy,experimentalRolldownParser:parserPolicy}),requiresCrossOriginIsolation:true,ownerHeaders:isolationHeaders})
}

/** Reject a browser that cannot satisfy the selected packaged runtime. */
export function assertSDKRuntimeEnvironment(profile:Readonly<SDKRuntimeProfile>,environment:SDKRuntimeEnvironment={
  crossOriginIsolated:globalThis.crossOriginIsolated===true,
  sharedArrayBuffer:typeof globalThis.SharedArrayBuffer==='function',
}):void{
  if(!profile||typeof profile!=='object'||(profile.workload!=='vite'&&profile.workload!=='tanstack-start')||typeof profile.requiresCrossOriginIsolation!=='boolean')throw Error('Invalid SDK runtime profile')
  if(profile.requiresCrossOriginIsolation&&(!environment.crossOriginIsolated||!environment.sharedArrayBuffer))throw Error('The '+profile.workload+' runtime requires cross-origin isolation and SharedArrayBuffer. Serve the owner with COOP same-origin and COEP require-corp.')
}
