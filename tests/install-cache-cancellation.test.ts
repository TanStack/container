import {expect,test,vi} from 'vitest'
import {npmProject} from './fixtures/npm-project'
import {installProject} from '../src/npm/project'
import {WorkspaceFiles} from '../src/sandbox/files'

const cacheRead=vi.hoisted(()=>({started:undefined as undefined|(()=>void)}))
vi.mock('../src/npm/package-cache-storage',async importOriginal=>({
  ...await importOriginal<typeof import('../src/npm/package-cache-storage')>(),
  loadPackageRecords:async()=>[],
  readPackageRecord:()=>{cacheRead.started?.();return new Promise(()=>{})},
}))

test('abort settles an install waiting on persistent archive cache',async()=>{
  const fixture=npmProject()
  const files=new WorkspaceFiles(fixture.files)
  const before=files.snapshot()
  const controller=new AbortController()
  const reason=Error('cancel pending archive cache')
  let started!:()=>void
  const ready=new Promise<void>(resolve=>{started=resolve})
  cacheRead.started=started
  const install=installProject(files,{},controller.signal)
  const outcome=install.then(()=> 'unexpected success',error=>error===reason?'cancelled':String(error))
  await ready
  controller.abort(reason)
  const result=await Promise.race([outcome,new Promise<string>(resolve=>setTimeout(()=>resolve('still pending'),100))])
  expect(result).toBe('cancelled')
  expect(files.snapshot()).toEqual(before)
  files.close()
})
