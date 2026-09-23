import {describe,it,expect} from 'vitest'
import {resolveRuntimeAssetBase,runtimeAssetURL} from '../src/sandbox/runtime-assets'

describe('runtime asset ownership',()=>{
  const location='https://example.test/app/page.html'
  it('preserves the lab default and accepts nested same-origin directories',()=>{
    expect(resolveRuntimeAssetBase(undefined,location)).toBe('https://example.test/')
    const base=resolveRuntimeAssetBase('./vendor/runtime/',location)
    expect(base).toBe('https://example.test/app/vendor/runtime/')
    expect(runtimeAssetURL('kernel-runtime/builtins.json',base).href).toBe(base+'kernel-runtime/builtins.json')
  })
  it('rejects ambiguous or untrusted asset locations',()=>{
    for(const input of [null,{},1,'https://other.test/runtime/','data:text/javascript,x','file:///tmp/','/runtime','/runtime/?v=1','/runtime/#x','https://user:pass@example.test/runtime/']){
      expect(()=>resolveRuntimeAssetBase(input,location)).toThrow()
    }
  })
})
