import {afterEach,expect,test,vi} from 'vitest'
import {wasmBootstrapDiagnostics} from '../src/native/wasm-bootstrap-diagnostics'
afterEach(()=>vi.unstubAllGlobals())
test('records whether a minimal module compiles without altering the compiler',async()=>{
  const original=WebAssembly
  expect(await wasmBootstrapDiagnostics()).toMatchObject({available:true,minimalValid:true,minimalInstantiated:true})
  expect(WebAssembly).toBe(original)
})
test('preserves compiler failure as diagnostic evidence',async()=>{
  vi.stubGlobal('WebAssembly',{validate:()=>true,instantiate:async()=>{throw Error('compiler unavailable')}})
  expect(await wasmBootstrapDiagnostics()).toMatchObject({available:true,minimalValid:true,error:'Error: compiler unavailable'})
})
