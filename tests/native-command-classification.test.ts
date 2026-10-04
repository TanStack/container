import {expect,test} from 'vitest'
import {isNativeViteBuild,isNativeViteDev,isNativeTypecheck,nativeViteDevOptions} from '../src/native/command-classification'

const vite='/app/node_modules/vite/bin/vite.js'

test('recognizes direct Vite build and dev commands without claiming other binaries',()=>{
  expect(isNativeViteBuild(vite,['build'])).toBe(true)
  expect(isNativeViteDev(vite,[])).toBe(true)
  expect(isNativeViteDev(vite,['dev'])).toBe(true)
  expect(isNativeViteDev(vite,['serve'])).toBe(true)
  expect(isNativeViteDev(vite,['dev','--configLoader','runner'])).toBe(true)
  expect(nativeViteDevOptions(vite,['--host'])).toEqual({host:true})
  expect(nativeViteDevOptions(vite,['dev','--host','127.0.0.1'])).toEqual({host:'127.0.0.1'})
  expect(isNativeViteDev(vite,['dev','--host','--configLoader','runner'])).toBe(true)
  expect(isNativeViteDev(vite,['dev','--unknown'])).toBe(false)
  expect(isNativeViteDev(vite,['build'])).toBe(false)
  expect(isNativeViteDev('/app/node_modules/other/bin/vite.js',['dev'])).toBe(false)
  expect(isNativeViteDev(vite,['dev'],'console.log(1)')).toBe(false)
  expect(isNativeTypecheck('/app/node_modules/typescript/bin/tsc',['--noEmit'])).toBe(true)
})
