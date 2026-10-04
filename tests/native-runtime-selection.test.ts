import {expect,test} from 'vitest'
import {selectNativeRuntime} from '../src/native/runtime-selection'
const candidates=[{workerURL:'/v11/engine.js',toolchain:{vite:'8.3.1',rolldown:'1.2.11'}},{workerURL:'/v12/engine.js',toolchain:{vite:'8.3.1',rolldown:'1.2.12'}}]
test('does not fall back from a present invalid shrinkwrap',()=>{
  const fallback={'/app/package-lock.json':JSON.stringify({packages:{'node_modules/rolldown':{version:'1.2.11'}}})}
  for(const source of ['null','false','42','"invalid"','[]']){
    expect(()=>selectNativeRuntime({...fallback,'/app/npm-shrinkwrap.json':source},candidates)).toThrow('Invalid project lockfile: /app/npm-shrinkwrap.json')
  }
})
test('uses shrinkwrap before package-lock, matching project installation',()=>{
  const files={
    '/app/npm-shrinkwrap.json':JSON.stringify({packages:{'node_modules/vite':{version:'8.3.1'},'node_modules/rolldown':{version:'1.2.12'}}}),
    '/app/package-lock.json':JSON.stringify({packages:{'node_modules/vite':{version:'8.3.1'},'node_modules/rolldown':{version:'1.2.11'}}}),
  }
  expect(selectNativeRuntime(files,candidates)).toBe(candidates[1])
  expect(selectNativeRuntime({...files,'/app/package-lock.json':'unused invalid JSON'},candidates)).toBe(candidates[1])
  expect(()=>selectNativeRuntime(files,[candidates[0]!])).toThrow('found 0')
})
test('installed snapshots ignore stale shrinkwrap compiler versions',()=>{
  const files={
    '/app/npm-shrinkwrap.json':'unused invalid JSON',
    '/app/node_modules/vite/package.json':'{"version":"8.3.1"}',
    '/app/node_modules/rolldown/package.json':'{"version":"1.2.11"}',
  }
  expect(selectNativeRuntime(files,candidates,undefined,true)).toBe(candidates[0])
})
test('selects the exact npm lock compiler without patching dependencies',()=>{
  const files={'/app/package-lock.json':JSON.stringify({packages:{'node_modules/vite':{version:'8.3.1'},'node_modules/rolldown':{version:'1.2.12'}}})}
  expect(selectNativeRuntime(files,candidates)).toBe(candidates[1])
  expect(()=>selectNativeRuntime(files,[candidates[0]!])).toThrow('found 0')
  expect(()=>selectNativeRuntime(files,[candidates[1]!,candidates[1]!])).toThrow('found 2')
})
test('uses explicit runtime locks and mounted snapshots',()=>{
  const files={'/app/node_modules/rolldown/package.json':new TextEncoder().encode('{"version":"1.2.11"}')}
  expect(selectNativeRuntime(files,candidates)).toBe(candidates[0])
  expect(selectNativeRuntime(files,candidates,{version:1,packages:[{installPath:'/node_modules/rolldown',version:'1.2.12',resolved:'owned',integrity:'owned'}]})).toBe(candidates[1])
  expect(selectNativeRuntime({...files,'/app/package-lock.json':'{"packages":{"node_modules/rolldown":{"version":"1.2.12"}}}'},candidates,undefined,true)).toBe(candidates[0])
  expect(()=>selectNativeRuntime({},candidates)).toThrow('requires locked or mounted')
})
