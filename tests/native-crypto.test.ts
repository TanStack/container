import {describe,expect,it} from 'vitest'
import {createHash,createHmac,timingSafeEqual} from '../src/vite-browser/node-crypto'
import {createHash as nodeCreateHash,createHmac as nodeCreateHmac} from 'node:crypto'

describe('native browser crypto adapter',()=>{
  it('supports Node base64url hash and HMAC digests',()=>{
    expect(createHash('sha256').update('container').digest('base64url'))
      .toBe(nodeCreateHash('sha256').update('container').digest('base64url'))
    expect(createHmac('sha256','key').update('container').digest('base64url'))
      .toBe(nodeCreateHmac('sha256','key').update('container').digest('base64url'))
  })
  it('compares byte views and rejects unequal lengths',()=>{
    const bytes=new Uint8Array([9,1,2,3])
    expect(timingSafeEqual(bytes.subarray(1),new Uint8Array([1,2,3]))).toBe(true)
    expect(timingSafeEqual(bytes.subarray(1),new Uint8Array([1,2,4]))).toBe(false)
    expect(()=>timingSafeEqual(bytes,new Uint8Array(3))).toThrow(RangeError)
    expect(()=>timingSafeEqual(null as unknown as Uint8Array,bytes)).toThrow(TypeError)
  })
})
