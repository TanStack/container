import {applyWasmMemoryPolicy} from '../src/compiler/wasm-memory-policy.ts'

export function prepareSafariEsbuildProbe(bytes,maxPages=1024){
  if(!(bytes instanceof Uint8Array))throw Error('Safari esbuild probe requires Uint8Array compiler bytes')
  if(maxPages!==1024)throw Error('Safari esbuild probe must use the production 1024-page cap')
  return applyWasmMemoryPolicy(bytes,maxPages)
}
