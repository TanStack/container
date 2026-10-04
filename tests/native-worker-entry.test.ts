import {test,expect} from 'vitest'
import {resolveWorkerEntry,resolveWorkerProgram,workerExecArgv} from '../src/native/worker-entry'
test('worker launch flags inherit, snapshot and allow an explicit empty override',()=>{
  const inherited=['--require','./setup.cjs']
  const selected=workerExecArgv(undefined,inherited)
  inherited.push('--import','./later.mjs')
  expect(selected).toEqual(['--require','./setup.cjs'])
  expect(workerExecArgv([],inherited)).toEqual([])
  expect(workerExecArgv(undefined,inherited,true)).toEqual([])
  const explicit=['--import','./setup.mjs']
  const overridden=workerExecArgv(explicit,inherited,true)
  explicit.length=0
  expect(overridden).toEqual(['--import','./setup.mjs'])
})
test('worker source selection matches Node truthiness and error codes',()=>{
  expect(resolveWorkerProgram('','/app',true)).toEqual({entry:'/app/[worker eval]',evalSource:''})
  expect(resolveWorkerProgram('40+2','/app','yes')).toEqual({entry:'/app/[worker eval]',evalSource:'40+2'})
  expect(resolveWorkerProgram('./child.mjs','/app',false)).toEqual({entry:'/app/child.mjs',evalSource:undefined})
  expect(()=>resolveWorkerProgram(new URL('file:///app/child.mjs'),'/app',true)).toThrow(expect.objectContaining({code:'ERR_INVALID_ARG_VALUE'}))
})
test('worker entry resolves relative to the current process directory',()=>{
  expect(resolveWorkerEntry('./child.mjs','/app/src')).toBe('/app/src/child.mjs')
  expect(resolveWorkerEntry('../child.mjs','/app/src')).toBe('/app/child.mjs')
  expect(resolveWorkerEntry('./child.mjs','/tmp/task')).toBe('/tmp/task/child.mjs')
  expect(resolveWorkerEntry(new URL('file:///app/hello%20world.mjs'),'/tmp')).toBe('/app/hello world.mjs')
})
test('rejects bare filenames, remote URLs, encoded separators and escapes',()=>{
  expect(()=>resolveWorkerEntry('child.mjs','/app')).toThrow(expect.objectContaining({code:'ERR_WORKER_PATH'}))
  for(const value of ['/etc/child.mjs','../../child.mjs',new URL('https://example.test/app/child.mjs'),
    new URL('file://example.test/app/child.mjs'),new URL('file:///app/a%2fb.mjs')])
    expect(()=>resolveWorkerEntry(value,'/app')).toThrow()
})
