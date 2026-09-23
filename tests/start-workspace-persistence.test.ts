import {expect,it} from 'vitest'
import {fingerprintStartWorkspace} from './sdk-frameworks/start-workspace-persistence'
import type {WorkspaceSnapshot} from '../src/sandbox/files'

const snapshot=():WorkspaceSnapshot=>({version:5,files:{'/project/count.txt':new TextEncoder().encode('2'),'/project/node_modules/.vite/deps/react.js':new Uint8Array([0,255,1])},directories:['/project','/project/node_modules','/project/node_modules/.vite','/project/node_modules/.vite/deps'],symlinks:{'/project/link':'count.txt'},fileModes:{'/project/count.txt':0o644},directoryModes:{'/project':0o755}})
it('fingerprints binary files and all persisted metadata independent of key order',async()=>{
  const original=snapshot(),restored=structuredClone(original)
  restored.files=Object.fromEntries(Object.entries(restored.files).reverse())
  const expected=await fingerprintStartWorkspace(original)
  expect(await fingerprintStartWorkspace(restored)).toEqual(expected)
  expect(expected).toMatchObject({files:2,bytes:4,packageFiles:1,cacheFiles:1})
})
it('detects changed file bytes, modes and symlink targets',async()=>{
  const expected=await fingerprintStartWorkspace(snapshot())
  for(const change of [
    (value:any)=>{value.files['/project/count.txt'][0]=51},
    (value:any)=>{value.fileModes['/project/count.txt']=0o600},
    (value:any)=>{value.directoryModes['/project']=0o700},
    (value:any)=>{value.symlinks['/project/link']='other.txt'},
  ]){
    const value=snapshot();change(value)
    expect((await fingerprintStartWorkspace(value)).sha256).not.toBe(expected.sha256)
  }
})
