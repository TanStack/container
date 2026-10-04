import {afterEach,expect,test,vi} from 'vitest'
import {Volume} from 'memfs'
import {npmProject} from './fixtures/npm-project'
import {planProjectInstall} from '../src/npm/project'
import {installLiveLockedPackages} from '../src/native/live-package-install'

afterEach(()=>vi.unstubAllGlobals())
function project(){
  const fixture=npmProject(),volume=new Volume()
  volume.mkdirSync('/app/node_modules/stale',{recursive:true})
  for(const [path,text] of Object.entries(fixture.files)){
    const target='/app'+path
    volume.mkdirSync(target.slice(0,target.lastIndexOf('/')),{recursive:true})
    volume.writeFileSync(target,text)
  }
  const manifest=String(volume.readFileSync('/app/package.json'))
  const lockText=String(volume.readFileSync('/app/package-lock.json'))
  const planned=planProjectInstall(manifest,lockText)
  const lock={version:1 as const,packages:planned.lock.packages.map(pkg=>({...pkg,installPath:'/app'+pkg.installPath}))}
  return {fixture,volume,manifest,lockText,lock}
}
test('live shrinkwrap install updates only the selected lockfile',async()=>{
  const {fixture,volume,manifest,lockText,lock}=project()
  volume.writeFileSync('/app/npm-shrinkwrap.json',lockText)
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>new Response(Uint8Array.from(fixture.archives[url]))))
  const result=await installLiveLockedPackages(volume,lock,{expectedManifest:manifest,expectedLock:lockText,lockText:lockText+'\n'})
  expect(String(volume.readFileSync('/app/npm-shrinkwrap.json'))).toBe(lockText+'\n')
  expect(String(volume.readFileSync('/app/package-lock.json'))).toBe(lockText)
  expect(result.changedPaths).toEqual(['/app/node_modules','/app/npm-shrinkwrap.json'])
})
test('failed refresh restores shrinkwrap and leaves package-lock untouched',async()=>{
  const {fixture,volume,manifest,lockText,lock}=project()
  volume.writeFileSync('/app/npm-shrinkwrap.json',lockText)
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>new Response(Uint8Array.from(fixture.archives[url]))))
  await expect(installLiveLockedPackages(volume,lock,{expectedManifest:manifest,expectedLock:lockText,
    lockText:lockText+'\n',afterCommit:async()=>{throw Error('refresh failed')}})).rejects.toThrow('refresh failed')
  expect(String(volume.readFileSync('/app/npm-shrinkwrap.json'))).toBe(lockText)
  expect(String(volume.readFileSync('/app/package-lock.json'))).toBe(lockText)
  expect(String(volume.readFileSync('/app/node_modules/stale/index.js'))).toBe('stale')
})
test('adding shrinkwrap during staging rejects without swapping the package tree',async()=>{
  const {fixture,volume,manifest,lockText,lock}=project()
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
    volume.writeFileSync('/app/npm-shrinkwrap.json',lockText)
    return new Response(Uint8Array.from(fixture.archives[url]))
  }))
  await expect(installLiveLockedPackages(volume,lock,{expectedManifest:manifest,expectedLock:lockText})).rejects.toThrow('lockfile changed')
  expect(String(volume.readFileSync('/app/node_modules/stale/index.js'))).toBe('stale')
  expect(String(volume.readFileSync('/app/package-lock.json'))).toBe(lockText)
})
test('live locked install swaps verified packages and keeps the project files',async()=>{
  const {fixture,volume,manifest,lockText,lock}=project()
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>new Response(Uint8Array.from(fixture.archives[url]))))
  const result=await installLiveLockedPackages(volume,lock,{expectedManifest:manifest,expectedLock:lockText})
  expect(result.installed).toBe(3)
  expect(volume.existsSync('/app/node_modules/stale')).toBe(false)
  expect(String(volume.readFileSync('/app/node_modules/parent/index.js'))).toContain('require("child")')
  expect(String(volume.realpathSync('/app/node_modules/.bin/parent'))).toBe('/app/node_modules/parent/index.js')
  expect(String(volume.readFileSync('/app/keep.txt'))).toBe('keep')
  expect(volume.readdirSync('/app').map(String).some(name=>name.startsWith('.native-install-'))).toBe(false)
})
test('failed archive verification leaves old packages and lockfile untouched',async()=>{
  const {volume,manifest,lockText,lock}=project()
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(new Uint8Array([1,2,3]))))
  await expect(installLiveLockedPackages(volume,lock,{expectedManifest:manifest,expectedLock:lockText})).rejects.toThrow()
  expect(String(volume.readFileSync('/app/node_modules/stale/index.js'))).toBe('stale')
  expect(String(volume.readFileSync('/app/package-lock.json'))).toBe(lockText)
  expect(volume.readdirSync('/app').map(String).some(name=>name.startsWith('.native-install-'))).toBe(false)
})
test('a concurrent manifest edit rejects the staged install without replacing packages',async()=>{
  const {fixture,volume,manifest,lockText,lock}=project()
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
    volume.writeFileSync('/app/package.json',manifest+'\n')
    return new Response(Uint8Array.from(fixture.archives[url]))
  }))
  await expect(installLiveLockedPackages(volume,lock,{expectedManifest:manifest,expectedLock:lockText})).rejects.toThrow('changed during')
  expect(String(volume.readFileSync('/app/node_modules/stale/index.js'))).toBe('stale')
  expect(String(volume.readFileSync('/app/package-lock.json'))).toBe(lockText)
})
test('an interrupted staged install leaves the old package tree intact',async()=>{
  const {fixture,volume,manifest,lockText,lock}=project()
  const controller=new AbortController()
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
    controller.abort()
    return new Response(Uint8Array.from(fixture.archives[url]))
  }))
  await expect(installLiveLockedPackages(volume,lock,{
    expectedManifest:manifest,expectedLock:lockText,signal:controller.signal,
  })).rejects.toThrow()
  expect(String(volume.readFileSync('/app/node_modules/stale/index.js'))).toBe('stale')
  expect(String(volume.readFileSync('/app/package-lock.json'))).toBe(lockText)
  expect(volume.readdirSync('/app').map(String).some(name=>name.startsWith('.native-install-'))).toBe(false)
})
test('failed project refresh restores the old package tree and lockfile',async()=>{
  const {fixture,volume,manifest,lockText,lock}=project()
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>new Response(Uint8Array.from(fixture.archives[url]))))
  await expect(installLiveLockedPackages(volume,lock,{expectedManifest:manifest,expectedLock:lockText,
    lockText:lockText+'\n',afterCommit:async()=>{throw Error('refresh failed')}})).rejects.toThrow('refresh failed')
  expect(String(volume.readFileSync('/app/node_modules/stale/index.js'))).toBe('stale')
  expect(String(volume.readFileSync('/app/package-lock.json'))).toBe(lockText)
})
