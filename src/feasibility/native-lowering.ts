import {transform} from 'esbuild-wasm'

// Use the compiler initialized by compileProject, preserving top-level await.
export function lowerNativeModule(code:string){
  return transform(code,{target:'es2022',supported:{'async-await':false,'async-generator':false},format:'esm'})
}
