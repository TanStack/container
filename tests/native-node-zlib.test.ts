import {describe,expect,it} from 'vitest'
import zlib,{constants} from '../src/vite-browser/node-zlib'

describe('browser-native node:zlib',()=>{
  it('exposes the standard compression constants through the default export',()=>{
    expect(zlib.constants).toBe(constants)
    expect(constants.BROTLI_OPERATION_FLUSH).toBe(1)
    expect(constants.Z_FINISH).toBe(4)
  })
})
