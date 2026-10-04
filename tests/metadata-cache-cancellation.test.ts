import {expect,test,vi} from 'vitest'
import {PackageInstallCache} from '../src/npm/install'
import {resolveProjectLock} from '../src/npm/project'
const state=vi.hoisted(()=>({hydration:Promise.resolve([]) as Promise<any[]>,write:Promise.resolve() as Promise<void>}))
vi.mock('../src/npm/package-cache-storage',async importOriginal=>({
  ...await importOriginal<typeof import('../src/npm/package-cache-storage')>(),
  loadPackageRecords:()=>state.hydration,
  writePackageRecord:()=>state.write,
}))
test('cancelled resolution stops waiting for hydration while another caller finishes',async()=>{
  let release!:(value:any[])=>void
  state.hydration=new Promise(resolve=>{release=resolve})
  const cache=new PackageInstallCache()
  const controller=new AbortController(),reason=Error('cancel hydration')
  const first=resolveProjectLock('{}',controller.signal,cache)
  const second=resolveProjectLock('{}',undefined,cache)
  const rejected=expect(first).rejects.toBe(reason)
  controller.abort(reason)
  await rejected
  release([])
  expect(JSON.parse(await second).lockfileVersion).toBe(3)
})
test('cancelled resolution stops waiting for cache writes without cancelling shared persistence',async()=>{
  state.hydration=Promise.resolve([])
  let release!:()=>void
  state.write=new Promise(resolve=>{release=resolve})
  const cache=new PackageInstallCache()
  await cache.ready()
  cache.putMetadata('test','{}',2)
  const flush=vi.spyOn(cache,'flush')
  const controller=new AbortController(),reason=Error('cancel flush')
  const first=resolveProjectLock('{}',controller.signal,cache)
  const second=resolveProjectLock('{}',undefined,cache)
  const rejected=expect(first).rejects.toBe(reason)
  await vi.waitFor(()=>expect(flush).toHaveBeenCalledTimes(2))
  controller.abort(reason)
  await rejected
  release()
  expect(JSON.parse(await second).lockfileVersion).toBe(3)
})
