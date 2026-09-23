import {test,expect} from 'vitest'
import {spawnSync} from 'node:child_process'

test('native VM module oracle: live bindings, independent graph recovery and context ownership',()=>{
  const native=spawnSync(process.execPath,['--experimental-vm-modules','tests/fixtures/vm-module-native.mjs'],{encoding:'utf8',timeout:10000})
  expect(native.status,native.stderr).toBe(0)
  expect(JSON.parse(native.stdout)).toEqual({liveExport:24,context:42,importMeta:23,recovered:31,cycle:7,dynamic:31,errorIdentity:true})
})
