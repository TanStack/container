import {expect,test} from 'vitest'
import {nativeOwnerBuildId,verifyNativeOwnerBuildId} from '../src/native/owner-build-identity'

test('native host identity accepts exact configured values and legacy omission',()=>{
  expect(verifyNativeOwnerBuildId('sha256:abc','sha256:abc')).toBe('sha256:abc')
  expect(verifyNativeOwnerBuildId(undefined)).toBeUndefined()
  expect(verifyNativeOwnerBuildId('configured')).toBe('configured')
})
test('expected identity rejects missing and different hosts',()=>{
  expect(()=>verifyNativeOwnerBuildId(undefined,'wanted')).toThrow('mismatch')
  expect(()=>verifyNativeOwnerBuildId('other','wanted')).toThrow('mismatch')
})
test('native identities reject empty, whitespace, oversized and non-string values',()=>{
  for(const value of ['', 'has space','line\nbreak','é','x'.repeat(257),null,1,{}])
    expect(()=>nativeOwnerBuildId(value)).toThrow(TypeError)
})
