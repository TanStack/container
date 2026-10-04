import {Buffer} from 'buffer'
import {describe,expect,it} from 'vitest'
import {installBufferBase64Url} from '../src/vite-browser/node-buffer'

describe('browser Buffer base64url',()=>{
  it('round-trips unpadded URL-safe data through from and toString',()=>{
    installBufferBase64Url()
    const input='{"file":"/route?split=yes","export":"readCount"}'
    const encoded=Buffer.from(input).toString('base64url')
    expect(encoded).not.toContain('=')
    expect(Buffer.from(encoded,'base64url').toString('utf8')).toBe(input)
  })
})
