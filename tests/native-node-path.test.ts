import {describe,expect,it} from 'vitest'
import nodePath,{posix,toNamespacedPath} from '../src/vite-browser/node-path'

describe('browser-native POSIX path',()=>{
  it('preserves paths through the Node namespaced-path API',()=>{
    for(const filename of ['/app/package.json','./src/index.ts','']){
      expect(toNamespacedPath(filename)).toBe(filename)
      expect(posix.toNamespacedPath(filename)).toBe(filename)
      expect(nodePath.toNamespacedPath(filename)).toBe(filename)
    }
  })
})
