import {afterEach,describe,expect,it,vi} from 'vitest'
import {vol} from '../src/vite-browser/node-fs'

vi.mock('../src/vite-browser/node-module',()=>({
  isBuiltin:()=>false,
  createRequire:()=>{throw Error('Builtins are not part of this module-format test')},
}))

import {BrowserCommonJS} from '../src/native/commonjs'

afterEach(()=>vol.reset())

describe('browser CommonJS module classification',()=>{
  it('respects a declared ESM module entry in a package without a type field',()=>{
    vol.fromJSON({
      '/app/node_modules/dual/package.json':'{"main":"dist/index.js","module":"dist/index.module.js"}',
      '/app/node_modules/dual/dist/index.js':'module.exports="commonjs"',
      '/app/node_modules/dual/dist/index.module.js':'export default "esm"',
    })
    const loader=new BrowserCommonJS()
    expect(loader.isCommonJS('/app/node_modules/dual/dist/index.js')).toBe(true)
    expect(loader.isCommonJS('/app/node_modules/dual/dist/index.module.js')).toBe(false)
    expect(()=>loader.load('/app/node_modules/dual/dist/index.module.js')).toThrow('Synchronous require cannot load ESM')
  })
})
