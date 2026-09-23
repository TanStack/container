import {test,expect} from '@playwright/test'

test('kernel checkpoints persist and restore without returning workspace bytes to the page',async({page})=>{
  await page.goto('/sandbox.html')
  const saved=await page.evaluate(async()=>{
    const {WorkerKernel}=window.sandboxLab
    const kernel=new WorkerKernel({}, {workspace:{maxBytes:8*1024*1024}})
    try{
      await kernel.deleteCheckpoint('kernel-owned-e2e')
      const repeated=new Uint8Array(2*1024*1024);repeated.fill(42)
      await kernel.restore({
        version:5,
        files:{'/src/large.bin':repeated,'/src/main.ts':new TextEncoder().encode('export const value = 1')},
        directories:['/src','/empty'],symlinks:{'/entry.ts':'/src/main.ts'},
        fileModes:{'/src/large.bin':0o600,'/src/main.ts':0o644},
        directoryModes:{'/':0o755,'/src':0o750,'/empty':0o700},
      })
      const metadata=await kernel.saveCheckpoint('kernel-owned-e2e')
      return {metadata,lookup:await kernel.checkpointMetadata('kernel-owned-e2e')}
    }finally{kernel.close()}
  })
  expect(saved.metadata).toEqual(saved.lookup)
  expect(saved.metadata).toMatchObject({
    key:'kernel-owned-e2e',formatVersion:1,snapshotVersion:5,
    files:2,directories:2,symlinks:1,bytes:2*1024*1024+22,chunks:2,
  })
  expect(Object.keys(saved.metadata).sort()).toEqual(['bytes','chunks','createdAt','directories','files','formatVersion','key','snapshotVersion','symlinks','updatedAt'])

  await page.reload()
  const restored=await page.evaluate(async()=>{
    const {WorkerKernel}=window.sandboxLab
    const kernel=new WorkerKernel({}, {workspace:{maxBytes:8*1024*1024}})
    try{
      const metadata=await kernel.restoreCheckpoint('kernel-owned-e2e')
      const snapshot=await kernel.snapshot()
      await kernel.writeText('/src/main.ts','export const value = 2')
      const replacement=await kernel.saveCheckpoint('kernel-owned-e2e')
      const removed=await kernel.deleteCheckpoint('kernel-owned-e2e')
      const missing=await kernel.checkpointMetadata('kernel-owned-e2e')
      const missingError=await kernel.restoreCheckpoint('kernel-owned-e2e').then(()=>'',error=>String(error))
      return {
        metadata,replacement,removed,missing,missingError,
        version:snapshot.version,
        source:new TextDecoder().decode(snapshot.files['/src/main.ts']),
        large:[snapshot.files['/src/large.bin'].length,snapshot.files['/src/large.bin'][0],snapshot.files['/src/large.bin'].at(-1)],
        directories:'directories' in snapshot?snapshot.directories:[],
        symlinks:'symlinks' in snapshot?snapshot.symlinks:{},
        fileModes:'fileModes' in snapshot?snapshot.fileModes:{},
        directoryModes:'directoryModes' in snapshot?snapshot.directoryModes:{},
      }
    }finally{kernel.close()}
  })
  expect(restored).toMatchObject({
    removed:true,missing:undefined,version:5,source:'export const value = 1',
    large:[2*1024*1024,42,42],directories:['/empty','/src'],symlinks:{'/entry.ts':'/src/main.ts'},
    fileModes:{'/src/large.bin':0o600,'/src/main.ts':0o644},
    directoryModes:{'/':0o755,'/src':0o750,'/empty':0o700},
  })
  expect(restored.replacement.createdAt).toBe(restored.metadata.createdAt)
  expect(restored.replacement.updatedAt).toBeGreaterThanOrEqual(restored.metadata.updatedAt)
  expect(restored.missingError).toContain('No checkpoint: kernel-owned-e2e')
})
