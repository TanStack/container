import {expect,test,vi,beforeEach} from 'vitest'
const resolve=vi.hoisted(()=>vi.fn())
vi.mock('../src/npm/project',async original=>({...await original<typeof import('../src/npm/project')>(),resolveProjectLock:resolve}))
import {prepareNativeRuntime} from '../src/native/prepare-runtime'
const candidates=[{workerURL:'/runtime.js',toolchain:{vite:'8.3.1',rolldown:'1.2.11'}}]
const manifest=JSON.stringify({dependencies:{vite:'^8.3.0'}})
const locked=JSON.stringify({lockfileVersion:3,packages:{'':{dependencies:{vite:'^8.3.0'}},'node_modules/vite':{version:'8.3.1',resolved:'https://registry.npmjs.org/vite/-/vite-8.3.1.tgz',integrity:'sha512-'+Buffer.alloc(64).toString('base64')}}})
beforeEach(()=>{resolve.mockReset()})
test('resolves lockless dependencies once and returns the same lock for startup',async()=>{
  resolve.mockResolvedValue(locked)
  const input={'/app/package.json':manifest}
  const result=await prepareNativeRuntime(input,candidates)
  expect(resolve).toHaveBeenCalledTimes(1)
  expect(result.files['/app/package-lock.json']).toBe(locked)
  expect(result.lock?.packages[0]?.version).toBe('8.3.1')
  expect(result.candidate).toBe(candidates[0])
  expect(Object.keys(input)).toEqual(['/app/package.json'])
})
test('does not resolve or replace a present invalid shrinkwrap',async()=>{
  await expect(prepareNativeRuntime({'/app/npm-shrinkwrap.json':'null','/app/package-lock.json':locked},candidates)).rejects.toThrow('Invalid project lockfile')
  expect(resolve).not.toHaveBeenCalled()
})
test('requires exact available compiler assets after resolution',async()=>{
  resolve.mockResolvedValue(locked)
  await expect(prepareNativeRuntime({'/app/package.json':manifest},[])).rejects.toThrow('found 0')
})
test('installed-only workspaces use mounted versions without registry requests',async()=>{
  const result=await prepareNativeRuntime({'/app/node_modules/vite/package.json':'{"version":"8.3.1"}','/app/package-lock.json':'invalid'},candidates,{installedOnly:true})
  expect(result.candidate).toBe(candidates[0]);expect(resolve).not.toHaveBeenCalled()
})
test('already cancelled preparation does not resolve dependencies',async()=>{
  const reason=Error('cancel preparation')
  await expect(prepareNativeRuntime({'/app/package.json':manifest},candidates,{signal:AbortSignal.abort(reason)})).rejects.toBe(reason)
  expect(resolve).not.toHaveBeenCalled()
})
test('cancellation during resolution cannot return a ready runtime',async()=>{
  let finish!:(value:string)=>void
  resolve.mockImplementation(()=>new Promise<string>(done=>{finish=done}))
  const controller=new AbortController(),reason=Error('cancel resolving')
  const prepared=prepareNativeRuntime({'/app/package.json':manifest},candidates,{signal:controller.signal})
  const rejected=expect(prepared).rejects.toBe(reason)
  expect(resolve.mock.calls[0][1]).toBe(controller.signal)
  controller.abort(reason)
  finish(locked)
  await rejected
})
test('captures file contents before asynchronous dependency resolution',async()=>{
  let finish!:(value:string)=>void
  resolve.mockImplementation(()=>new Promise<string>(done=>{finish=done}))
  const bytes=new TextEncoder().encode('original')
  const files={'/app/package.json':manifest,'/app/file.txt':bytes}
  const prepared=prepareNativeRuntime(files,candidates)
  files['/app/package.json']='invalid later manifest';bytes.fill(0)
  finish(locked)
  const result=await prepared
  expect(result.files['/app/package.json']).toBe(manifest)
  expect(new TextDecoder().decode(result.files['/app/file.txt'] as Uint8Array)).toBe('original')
})
