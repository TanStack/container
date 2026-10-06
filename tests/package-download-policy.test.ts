import {afterEach,expect,test,vi} from 'vitest'
import {normalizePackageDownloadPolicy,packageDownloadURL} from '../src/npm/download-policy'
import {installProject,planProjectInstall,resolveProjectLock} from '../src/npm/project'
import {installLockedPackages,PackageInstallCache} from '../src/npm/install'
import {WorkspaceFiles} from '../src/sandbox/files'
import {npmProject} from './fixtures/npm-project'

afterEach(()=>vi.unstubAllGlobals())
const packageDownloadPolicy={additionalOrigins:['https://packages.example']}
function previewProject(){
  const fixture=npmProject()
  for(const entry of Object.values(fixture.lock.packages) as Array<{resolved?:string}>){
    if(!entry.resolved)continue
    const previous=entry.resolved
    entry.resolved=previous.replace('https://registry.npmjs.org','https://packages.example')
    fixture.archives[entry.resolved]=fixture.archives[previous]
  }
  fixture.files['/package-lock.json']=JSON.stringify(fixture.lock)
  return fixture
}

test('the default policy remains registry-only and an opt-in uses exact HTTPS origins',()=>{
  expect(packageDownloadURL('https://registry.npmjs.org/example/-/example-1.0.0.tgz').origin).toBe('https://registry.npmjs.org')
  expect(()=>packageDownloadURL('https://packages.example/package@commit')).toThrow('host-configured origins')
  expect(packageDownloadURL('https://packages.example/package@commit',packageDownloadPolicy).origin).toBe('https://packages.example')
  expect(()=>packageDownloadURL('https://sub.packages.example/package',packageDownloadPolicy)).toThrow('host-configured origins')
  expect(()=>packageDownloadURL('https://packages.example:8443/package',packageDownloadPolicy)).toThrow('host-configured origins')
  expect(packageDownloadURL('https://packages.example:8443/package',{additionalOrigins:['https://packages.example:8443']}).port).toBe('8443')
})

test.each(['http://packages.example','https://packages.example/','https://packages.example/path','https://packages.example?version=1','https://packages.example#package'])('policy rejects a non-origin entry %s',origin=>{
  expect(()=>normalizePackageDownloadPolicy({additionalOrigins:[origin]})).toThrow()
})

test('policy captures a bounded immutable copy instead of retaining caller-owned arrays',()=>{
  const additionalOrigins=['https://b.example','https://a.example','https://b.example']
  const captured=normalizePackageDownloadPolicy({additionalOrigins})
  additionalOrigins.push('https://later.example')
  expect(captured.additionalOrigins).toEqual(['https://a.example','https://b.example'])
  expect(Object.isFrozen(captured)).toBe(true);expect(Object.isFrozen(captured.additionalOrigins)).toBe(true)
  expect(()=>normalizePackageDownloadPolicy({additionalOrigins:Array(33).fill('https://a.example')})).toThrow('32')
  expect(()=>normalizePackageDownloadPolicy({additionalOrigins:null} as any)).toThrow()
  expect(()=>normalizePackageDownloadPolicy({allowAny:true} as any)).toThrow('Unknown')
})

test.each(['http://packages.example/package','https://user:pass@packages.example/package','https://packages.example/package#ref'])('archive location rejects unsupported URL form %s',url=>{
  expect(()=>packageDownloadURL(url,packageDownloadPolicy)).toThrow('HTTPS without credentials or a fragment')
})

test('locked URL packages install transactionally with the explicit policy',async()=>{
  const fixture=previewProject(),files=new WorkspaceFiles(fixture.files)
  const fetch=vi.fn(async(url:string,options:RequestInit)=>{
    expect(options.credentials).toBe('omit');expect(options.redirect).toBe('error')
    return new Response(Uint8Array.from(fixture.archives[url]))
  })
  vi.stubGlobal('fetch',fetch)
  try{
    const before=files.snapshot()
    await expect(installProject(files)).rejects.toThrow('host-configured origins')
    expect(files.snapshot()).toEqual(before);expect(fetch).not.toHaveBeenCalled()
    const installed=await installProject(files,{packageDownloadPolicy})
    expect(installed.installed).toBe(3)
    expect(files.existsSync('/node_modules/stale')).toBe(false)
    expect(files.realpathSync('/node_modules/.bin/parent')).toBe('/node_modules/parent/index.js')
    expect(new TextDecoder().decode(files.readFileSync('/keep.txt'))).toBe('keep')
    expect(fetch).toHaveBeenCalledTimes(3)
  }finally{files.close()}
})

test('a declared URL dependency must match its resolved lock entry',()=>{
  const fixture=previewProject()
  const url=fixture.lock.packages['node_modules/parent'].resolved
  fixture.manifest.dependencies.parent=url
  fixture.lock.packages[''].dependencies.parent=url
  expect(planProjectInstall(JSON.stringify(fixture.manifest),JSON.stringify(fixture.lock),{packageDownloadPolicy}).lock.packages).toHaveLength(3)
  fixture.lock.packages['node_modules/parent'].resolved='https://packages.example/different-package'
  expect(()=>planProjectInstall(JSON.stringify(fixture.manifest),JSON.stringify(fixture.lock),{packageDownloadPolicy})).toThrow('does not match dependency parent')
})

test('integrity is still required before a custom-origin archive is fetched',async()=>{
  const fixture=previewProject(),fetch=vi.fn()
  vi.stubGlobal('fetch',fetch)
  fixture.lock.packages['node_modules/parent'].integrity=''
  expect(()=>planProjectInstall(JSON.stringify(fixture.manifest),JSON.stringify(fixture.lock),{packageDownloadPolicy})).toThrow('SHA-512')
  const files=new WorkspaceFiles({})
  try{
    await expect(installLockedPackages(files,{version:1,packages:[{...fixture.lock.packages['node_modules/parent'],installPath:'/node_modules/parent'}]},undefined,undefined,undefined,undefined,packageDownloadPolicy)).rejects.toThrow('SHA-512')
    expect(fetch).not.toHaveBeenCalled()
  }finally{files.close()}
})

test('a wrong digest at an allowed origin keeps the existing project tree',async()=>{
  const fixture=previewProject(),files=new WorkspaceFiles(fixture.files)
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(new Uint8Array([1,2,3]))))
  try{
    const before=files.snapshot()
    await expect(installProject(files,{packageDownloadPolicy})).rejects.toThrow('integrity')
    expect(files.snapshot()).toEqual(before)
  }finally{files.close()}
})

test('cached archives do not let a later caller bypass its registry-only configuration',async()=>{
  const fixture=previewProject(),cache=new PackageInstallCache(),files=new WorkspaceFiles({})
  const lock={version:1 as const,packages:[{...fixture.lock.packages['node_modules/child'],installPath:'/node_modules/child'}]}
  const fetch=vi.fn(async(url:string)=>new Response(Uint8Array.from(fixture.archives[url])))
  vi.stubGlobal('fetch',fetch)
  try{
    await installLockedPackages(files,lock,undefined,undefined,cache,undefined,packageDownloadPolicy)
    expect(fetch).toHaveBeenCalledOnce()
    await expect(installLockedPackages(files,lock,undefined,undefined,cache)).rejects.toThrow('host-configured origins')
    expect(fetch).toHaveBeenCalledOnce()
  }finally{files.close()}
})

test('mixed locked sources are all checked before the first download',async()=>{
  const fixture=previewProject(),files=new WorkspaceFiles({}),fetch=vi.fn()
  vi.stubGlobal('fetch',fetch)
  const entries=['node_modules/parent','node_modules/child'].map(path=>({...fixture.lock.packages[path],installPath:'/'+path}))
  entries[1].resolved='https://not-configured.example/child'
  try{
    await expect(installLockedPackages(files,{version:1,packages:entries},undefined,undefined,undefined,undefined,packageDownloadPolicy)).rejects.toThrow('host-configured origins')
    expect(fetch).not.toHaveBeenCalled()
  }finally{files.close()}
})

test('lockless URL specs stay explicit unsupported operations, not guessed registry versions',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch)
  await expect(resolveProjectLock(JSON.stringify({dependencies:{example:'https://packages.example/example'}}),undefined,undefined,undefined,packageDownloadPolicy)).rejects.toThrow('Lockless dependency spec is unsupported')
  expect(fetch).not.toHaveBeenCalled()
})
