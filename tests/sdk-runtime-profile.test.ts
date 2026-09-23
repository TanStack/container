import {describe,expect,it} from 'vitest'
import {assertSDKRuntimeEnvironment,resolveSDKRuntimeProfile} from '../src/sdk/runtime-profile'

const hash='a'.repeat(64)
const compiler={enabledByDefault:false,worker:'runtime/workers/browser-compiler.js',artifact:'runtime/compiler/artifact.json',version:'0.28.2',runtimeSHA256:hash}
const syncEngines={'quickjs-als':{},'quickjs-als-wasm':{}}
const fiberEngines={
  'quickjs-als-asyncify-atomics-fibers-shared-storage':{},
  'quickjs-als-asyncify-wasm-atomics-fibers-shared-storage':{},
}
const parser={enabledByDefault:false,directory:'runtime/rolldown-parser',artifact:'runtime/rolldown-parser/artifact.json',version:'1.2.9'}
const composite={buildProfile:'experimental-fibers-simd-lazy-initializers-o2-iterative-calls-module-import-exports-assignments-cooperative-heap-loops',engines:{...syncEngines,...fiberEngines},experimentalCompiler:compiler,experimentalRolldownParser:parser}

describe('packaged SDK runtime profiles',()=>{
  it('allows the explicit segmented diagnostic without changing runtime limits or isolation',()=>{
    for(const suffix of ['-segmented-interpreter','-segmented-interpreter-batched','-segmented-interpreter-batched-native-utf8','-segmented-interpreter-batched-native-utf8-buffer','-segmented-interpreter-batched-native-utf8-guest-sampling']){
      const diagnostic={...composite,buildProfile:composite.buildProfile+suffix}
      for(const workload of ['vite','tanstack-start'] as const){
      const baseline=resolveSDKRuntimeProfile(composite,workload)
      expect(resolveSDKRuntimeProfile(diagnostic,workload)).toEqual({...baseline,buildProfile:diagnostic.buildProfile})
      }
    }
  })
  it('resolves the proven Vite configuration without requiring isolation',()=>{
    const resolved=resolveSDKRuntimeProfile(composite,'vite')
    expect(resolved).toEqual({
      workload:'vite',buildProfile:composite.buildProfile,
      kernelOptions:{cooperative:false,experimentalCompiler:{maxMemoryPages:1024,timeoutMs:30000,lifetime:'session'}},
      requiresCrossOriginIsolation:false,ownerHeaders:{},
    })
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(Object.isFrozen(resolved.kernelOptions)).toBe(true)
    expect(()=>assertSDKRuntimeEnvironment(resolved,{crossOriginIsolated:false,sharedArrayBuffer:false})).not.toThrow()
  })

  it('resolves the proven TanStack Start configuration and declares its owner requirements',()=>{
    const resolved=resolveSDKRuntimeProfile(composite,'tanstack-start')
    expect(resolved).toEqual({
      workload:'tanstack-start',buildProfile:composite.buildProfile,
      kernelOptions:{cooperative:false,experimentalFibers:true,experimentalCompiler:{maxMemoryPages:1024,timeoutMs:30000,lifetime:'session'},experimentalRolldownParser:{timeoutMs:30000,maxSourceBytes:16*1024*1024}},
      requiresCrossOriginIsolation:true,
      ownerHeaders:{'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'},
    })
    expect(()=>assertSDKRuntimeEnvironment(resolved,{crossOriginIsolated:true,sharedArrayBuffer:true})).not.toThrow()
    expect(()=>assertSDKRuntimeEnvironment(resolved,{crossOriginIsolated:false,sharedArrayBuffer:true})).toThrow(/requires cross-origin isolation and SharedArrayBuffer/)
    expect(()=>assertSDKRuntimeEnvironment(resolved,{crossOriginIsolated:true,sharedArrayBuffer:false})).toThrow(/requires cross-origin isolation and SharedArrayBuffer/)
  })

  it('fails closed for unsupported profiles, workloads, engines and artifacts',()=>{
    expect(()=>resolveSDKRuntimeProfile({...composite,buildProfile:'future-profile'},'vite')).toThrow(/Unsupported SDK build profile/)
    expect(()=>resolveSDKRuntimeProfile(composite,'other' as 'vite')).toThrow(/Unsupported SDK runtime workload/)
    expect(()=>resolveSDKRuntimeProfile({...composite,engines:fiberEngines},'vite')).toThrow(/missing engine quickjs-als/)
    expect(()=>resolveSDKRuntimeProfile({...composite,buildProfile:'sync-o2'},'tanstack-start')).toThrow(/requires a packaged experimental fiber profile/)
    expect(()=>resolveSDKRuntimeProfile({...composite,experimentalCompiler:{...compiler,enabledByDefault:true}},'vite')).toThrow(/must be opt-in/)
    expect(()=>resolveSDKRuntimeProfile({...composite,experimentalCompiler:{...compiler,worker:'../compiler.js'}},'vite')).toThrow(/invalid browser compiler worker/)
    expect(()=>resolveSDKRuntimeProfile({...composite,experimentalCompiler:{...compiler,runtimeSHA256:'bad'}},'vite')).toThrow(/invalid browser compiler provenance/)
    expect(()=>resolveSDKRuntimeProfile({...composite,experimentalRolldownParser:{...parser,artifact:'runtime/other/artifact.json'}},'tanstack-start')).toThrow(/invalid native parser provenance/)
    expect(()=>resolveSDKRuntimeProfile({...composite,experimentalRolldownParser:{...parser,enabledByDefault:true}},'tanstack-start')).toThrow(/must be opt-in/)
  })
})
