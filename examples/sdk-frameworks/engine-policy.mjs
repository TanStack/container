const fiberProfiles=new Set([
  'experimental-fibers','experimental-fibers-simd','experimental-fibers-simd-lazy',
  'experimental-fibers-simd-lazy-fairness','experimental-fibers-simd-lazy-initializers',
  'experimental-fibers-simd-lazy-initializers-o2','experimental-fibers-simd-lazy-initializers-o2-assignments',
  'experimental-fibers-simd-lazy-initializers-o2-iterative-calls',
  'experimental-fibers-simd-lazy-initializers-o2-iterative-calls-module-import-exports',
  'experimental-fibers-simd-lazy-initializers-o2-iterative-calls-module-import-exports-assignments',
  'experimental-fibers-simd-lazy-initializers-o2-iterative-calls-module-import-exports-assignments-cooperative-heap-loops',
  'experimental-fibers-simd-lazy-initializers-o2-iterative-calls-module-import-exports-assignments-cooperative-heap-loops-segmented-interpreter-batched-native-utf8-buffer',
])
const nativeParserPolicy=Object.freeze({timeoutMs:30000,maxSourceBytes:16*1024*1024})

export function exampleEnginePolicy(manifest){
  const profile=manifest.buildProfile
  if(['default','sync-o2','sync-o2-vm-modules'].includes(profile)){
    for(const slot of ['quickjs-als','quickjs-als-wasm'])if(!manifest.engines?.[slot])throw Error('SDK manifest is missing engine '+slot)
    return {profile,options:{cooperative:false},requiresIsolation:false}
  }
  if(fiberProfiles.has(profile)){
    for(const slot of ['quickjs-als-asyncify-atomics-fibers-shared-storage','quickjs-als-asyncify-wasm-atomics-fibers-shared-storage'])if(!manifest.engines?.[slot])throw Error('SDK manifest is missing engine '+slot)
    const parser=manifest.experimentalRolldownParser
    if(!parser||parser.enabledByDefault!==false||!parser.directory||!parser.artifact)throw Error('SDK fiber profile is missing its opt-in native parser artifact')
    return {profile,options:{experimentalFibers:true,experimentalRolldownParser:nativeParserPolicy},requiresIsolation:true}
  }
  throw Error('Unsupported framework example SDK profile: '+String(profile))
}
