import {afterEach,expect,test,vi} from 'vitest'
import {npmProject,tarArchive} from './fixtures/npm-project'
import {planProjectInstall,installProject,resolveProjectLock} from '../src/npm/project'
import {WorkspaceFiles} from '../src/sandbox/files'
import {extractTarFiles} from '../src/npm/tar'
import {gzipSync} from 'node:zlib'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {satisfies} from 'semver'
import {PackageInstallCache} from '../src/npm/install'

afterEach(()=>vi.unstubAllGlobals())
function bundledProject(extra:Record<string,string>={},childManifest:Record<string,unknown>|null={name:'child',version:'2.0.0',bin:{child:'index.js'}}){
  const fixture=npmProject(),parent=fixture.lock.packages['node_modules/parent']
  parent.bundleDependencies=['child']
  fixture.lock.packages['node_modules/parent/node_modules/child']={version:'2.0.0',inBundle:true}
  const archive=gzipSync(tarArchive({
    'package/package.json':JSON.stringify({name:'parent',version:'1.0.0',dependencies:{child:'2.0.0'},bundleDependencies:['child']}),
    'package/index.js':'module.exports=require("child")',
    ...(childManifest?{'package/node_modules/child/package.json':JSON.stringify(childManifest)}:{}),
    'package/node_modules/child/index.js':'module.exports=2',...extra,
  }))
  parent.integrity='sha512-'+createHash('sha512').update(archive).digest('base64')
  fixture.archives[parent.resolved]=archive
  fixture.files['/package-lock.json']=JSON.stringify(fixture.lock)
  return fixture
}
function mockDownloads(archives:Record<string,Buffer>){
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>new Response(Uint8Array.from(archives[url]))))
}
test('ordinary lockfiles retain nested versions and commit executables without stale packages',async()=>{
  const fixture=npmProject();mockDownloads(fixture.archives)
  const fs=new WorkspaceFiles(fixture.files)
  expect(await installProject(fs)).toEqual({installed:3,skippedPlatformPackages:[],ignoredScripts:[]})
  expect(fs.existsSync('/node_modules/stale')).toBe(false)
  expect(fs.realpathSync('/node_modules/.bin/parent')).toBe('/node_modules/parent/index.js')
  expect(fs.statSync('/node_modules/.bin/parent').mode&0o777).toBe(0o755)
  expect(new TextDecoder().decode(fs.readFileSync('/keep.txt'))).toBe('keep')
})
test('executable collisions match npm by keeping the first package at a node_modules level',async()=>{
  const fixture=npmProject()
  const add=(installName:string,version:string,alias=false)=>{
    const archive=gzipSync(tarArchive({
      'package/package.json':JSON.stringify({name:'h3',version,bin:{h3:'bin/h3.mjs'}}),
      'package/bin/h3.mjs':'#!/usr/bin/env node',
    }))
    const resolved=`https://registry.npmjs.org/h3/-/h3-${version}.tgz`
    fixture.archives[resolved]=archive
    fixture.lock.packages[`node_modules/${installName}`]={...(alias?{name:'h3'}:{}),version,resolved,integrity:'sha512-'+createHash('sha512').update(archive).digest('base64')}
    const dependencies=fixture.manifest.dependencies as Record<string,string>
    dependencies[installName]=alias?`npm:h3@${version}`:version
    fixture.lock.packages[''].dependencies[installName]=dependencies[installName]
  }
  add('h3','2.0.1-rc.32');add('h3-v2','2.0.1-rc.20',true)
  fixture.files['/package.json']=JSON.stringify(fixture.manifest)
  fixture.files['/package-lock.json']=JSON.stringify(fixture.lock)
  mockDownloads(fixture.archives)
  const fs=new WorkspaceFiles(fixture.files)
  await installProject(fs)
  expect(fs.realpathSync('/node_modules/.bin/h3')).toBe('/node_modules/h3/bin/h3.mjs')
})
test('nested project installs replace only their dependency tree and commit atomically',async()=>{
  const fixture=npmProject();mockDownloads(fixture.archives)
  const fs=new WorkspaceFiles({...Object.fromEntries(Object.entries(fixture.files).map(([path,value])=>['/project'+path,value])),'/node_modules/untouched/index.js':'root','/sibling/keep':'sibling'})
  expect((await installProject(fs,{cwd:'/project'})).installed).toBe(3)
  expect(fs.existsSync('/project/node_modules/stale')).toBe(false)
  expect(fs.realpathSync('/project/node_modules/.bin/parent')).toBe('/project/node_modules/parent/index.js')
  expect(fs.existsSync('/node_modules/untouched/index.js')).toBe(true)
  expect(fs.existsSync('/sibling/keep')).toBe(true)
  const before=fs.snapshot()
  mockDownloads(Object.fromEntries(Object.keys(fixture.archives).map(url=>[url,Buffer.from('bad archive')])))
  await expect(installProject(fs,{cwd:'/project'})).resolves.toMatchObject({installed:3})
  expect(fs.snapshot()).toEqual(before)
  await expect(installProject(fs,{cwd:'/missing'})).rejects.toThrow('ENOENT')
  fs.close()
})
test('rejects stale, incomplete, unsafe and unsupported lockfiles before downloading',()=>{
  for(const mutate of [
    (x:any)=>{x.lockfileVersion=1},
    (x:any)=>{x.packages[''].dependencies.parent='2'},
    (x:any)=>{delete x.packages['node_modules/parent/node_modules/child'];delete x.packages['node_modules/child']},
    (x:any)=>{x.packages['node_modules/../escape']=x.packages['node_modules/child']},
    (x:any)=>{x.packages['node_modules/child'].resolved='https://example.com/archive'},
    (x:any)=>{x.packages['node_modules/child'].link=true},
  ]){
    const {manifest,lock}=npmProject();mutate(lock)
    expect(()=>planProjectInstall(JSON.stringify(manifest),JSON.stringify(lock))).toThrow()
  }
})
test('v2 locks, optional platform packages and ignored lifecycle scripts are explicit',()=>{
  const {manifest,lock}=npmProject();lock.lockfileVersion=2
  lock.packages['node_modules/native']={optional:true,os:['linux']}
  lock.packages['node_modules/parent'].hasInstallScript=true
  expect(planProjectInstall(JSON.stringify(manifest),JSON.stringify(lock)).result.ignoredScripts).toEqual(['/node_modules/parent'])
  const plan=planProjectInstall(JSON.stringify(manifest),JSON.stringify(lock),{ignoreScripts:true})
  expect(plan.result.ignoredScripts).toEqual(['/node_modules/parent'])
  expect(plan.result.skippedPlatformPackages).toEqual(['/node_modules/native'])
})
test('wasm32-only packages are portable while native platform selectors remain blocked',()=>{
  const fixture=npmProject(),child=fixture.lock.packages['node_modules/child']
  child.cpu=['wasm32']
  expect(()=>planProjectInstall(JSON.stringify(fixture.manifest),JSON.stringify(fixture.lock))).not.toThrow()
  child.os=['linux']
  expect(()=>planProjectInstall(JSON.stringify(fixture.manifest),JSON.stringify(fixture.lock))).toThrow('Platform-specific package requires a browser implementation')
})
test('peer dependencies use npm ancestor placement and exact semver ranges',()=>{
  const fixture=npmProject(),parent=fixture.lock.packages['node_modules/parent']
  parent.peerDependencies={child:'^1.0.0'}
  expect(()=>planProjectInstall(JSON.stringify(fixture.manifest),JSON.stringify(fixture.lock))).not.toThrow()
  parent.peerDependencies.child='^2.0.0'
  expect(()=>planProjectInstall(JSON.stringify(fixture.manifest),JSON.stringify(fixture.lock))).toThrow('peer dependency child@1.0.0 does not satisfy ^2.0.0')
  parent.peerDependenciesMeta={child:{optional:true}}
  expect(()=>planProjectInstall(JSON.stringify(fixture.manifest),JSON.stringify(fixture.lock))).not.toThrow()
  parent.peerDependencies={missing:'*'};parent.peerDependenciesMeta={missing:{optional:true}}
  expect(()=>planProjectInstall(JSON.stringify(fixture.manifest),JSON.stringify(fixture.lock))).not.toThrow()
  parent.peerDependenciesMeta={}
  expect(()=>planProjectInstall(JSON.stringify(fixture.manifest),JSON.stringify(fixture.lock))).toThrow('missing peer dependency missing')
  parent.peerDependencies={child:'workspace:*'}
  expect(()=>planProjectInstall(JSON.stringify(fixture.manifest),JSON.stringify(fixture.lock))).toThrow('Unsupported non-semver peer dependency range')
})
test('dependency versions and legacy lockfiles fail before installation',()=>{
  const fixture=npmProject(),parent=fixture.lock.packages['node_modules/parent']
  parent.dependencies.child='^1.0.0'
  expect(()=>planProjectInstall(JSON.stringify(fixture.manifest),JSON.stringify(fixture.lock))).toThrow('child@2.0.0 does not satisfy ^1.0.0')
  fixture.lock.lockfileVersion=1
  try{planProjectInstall(JSON.stringify(fixture.manifest),JSON.stringify(fixture.lock));throw Error('expected rejection')}
  catch(error){expect(error).toMatchObject({code:'ERR_UNSUPPORTED_OPERATION'});expect(String(error)).toContain('physical packages tree')}
})
test('Vite plugin peer range accepts the installed Vite version',()=>{
  const plugin=JSON.parse(readFileSync('node_modules/@vitejs/plugin-react/package.json','utf8'))
  const vite=JSON.parse(readFileSync('node_modules/vite/package.json','utf8'))
  expect(plugin.peerDependencies.vite).toBeTypeOf('string')
  expect(satisfies(vite.version,plugin.peerDependencies.vite)).toBe(true)
})
test('native npm lock control nests a conflicting transitive version under its requester',()=>{
  const lock=JSON.parse(readFileSync('package-lock.json','utf8')).packages
  const root=lock['node_modules/@babel/code-frame'],core=lock['node_modules/@babel/core'],nested=lock['node_modules/@babel/core/node_modules/@babel/code-frame']
  expect(satisfies(root.version,core.dependencies['@babel/code-frame'])).toBe(false)
  expect(satisfies(nested.version,core.dependencies['@babel/code-frame'])).toBe(true)
})
test('lockless direct semver dependencies resolve deterministically and retain lifecycle rollback',async()=>{
  const manifest={name:'lockless',version:'1.0.0',dependencies:{beta:'~2.0.0',alpha:'^1.0.0'}},archives:Record<string,Buffer>={},metadata:Record<string,unknown>={}
  const add=(name:string,versions:Array<{version:string;peerDependencies?:Record<string,string>;scripts?:Record<string,string>}>)=>{
    const entries:Record<string,unknown>={}
    for(const item of versions){
      const archive=gzipSync(tarArchive({'package/package.json':JSON.stringify({name,...item}),'package/index.js':'module.exports='+JSON.stringify(item.version)}))
      const tarball='https://registry.npmjs.org/'+name+'/-/'+name+'-'+item.version+'.tgz',integrity='sha512-'+createHash('sha512').update(archive).digest('base64')
      archives[tarball]=archive;entries[item.version]={name,...item,dist:{tarball,integrity}}
    }
    metadata[name]={name,versions:entries}
  }
  add('alpha',[{version:'1.0.0'},{version:'1.4.0',scripts:{install:'alpha-install'}},{version:'2.0.0'}])
  add('beta',[{version:'2.0.1',peerDependencies:{alpha:'^1.2.0'}},{version:'2.1.0'}])
  const requested:string[]=[]
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
    requested.push(url)
    const name=Object.keys(metadata).find(name=>url.endsWith('/'+name))
    return name?new Response(JSON.stringify(metadata[name]),{headers:{'content-type':'application/json'}}):new Response(Uint8Array.from(archives[url]))
  }))
  const fs=new WorkspaceFiles({'/package.json':JSON.stringify(manifest),'/keep':'original','/node_modules/stale/index.js':'stale'}),before=fs.snapshot()
  await expect(installProject(fs,{},undefined,async()=>{throw Error('lifecycle failed')})).rejects.toThrow('lifecycle failed')
  expect(fs.snapshot()).toEqual(before)
  const seen:string[]=[]
  expect(await installProject(fs,{},undefined,async task=>{seen.push(task.script)})).toMatchObject({installed:2})
  expect(seen).toEqual(['alpha-install'])
  expect(JSON.parse(new TextDecoder().decode(fs.readFileSync('/node_modules/alpha/package.json'))).version).toBe('1.4.0')
  expect(requested.filter(url=>!url.endsWith('.tgz'))).toEqual(['https://registry.npmjs.org/alpha','https://registry.npmjs.org/beta'])
  expect(requested.filter(url=>url.endsWith('.tgz'))).toHaveLength(2)
  fs.close()
})
test('lockless resolver hoists shared versions, nests conflicts and installs peers',async()=>{
  const integrity='sha512-'+'A'.repeat(86)+'==',metadata:Record<string,unknown>={}
  const add=(name:string,versions:Record<string,Record<string,unknown>>)=>metadata[name]={name,versions:Object.fromEntries(Object.entries(versions).map(([version,value])=>[version,{name,version,...value,dist:{tarball:`https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,integrity}}]))}
  add('a',{'1.0.0':{dependencies:{shared:'^1'},optionalDependencies:{absent:'^1'}}})
  add('b',{'1.0.0':{dependencies:{shared:'^2'}}})
  add('shared',{'1.5.0':{},'2.1.0':{}})
  add('plugin',{'1.0.0':{peerDependencies:{host:'^3'}}})
  add('host',{'3.2.0':{}});add('absent',{})
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>new Response(JSON.stringify(metadata[Object.keys(metadata).find(name=>url.endsWith('/'+name))!] ?? {versions:{}}))))
  const lock=JSON.parse(await resolveProjectLock(JSON.stringify({dependencies:{b:'1',a:'1',plugin:'1'}})))
  expect(lock.packages['node_modules/shared'].version).toBe('1.5.0')
  expect(lock.packages['node_modules/b/node_modules/shared'].version).toBe('2.1.0')
  expect(lock.packages['node_modules/host'].version).toBe('3.2.0')
  expect(lock.packages['node_modules/absent']).toBeUndefined()
  expect(Object.keys(lock.packages)).toEqual(['','node_modules/a','node_modules/shared','node_modules/b','node_modules/b/node_modules/shared','node_modules/plugin','node_modules/host'])
})
test('lockless resolver rejects cycles and unsupported protocols',async()=>{
  const integrity='sha512-'+'A'.repeat(86)+'==',metadata:Record<string,unknown>={
    a:{versions:{'1.0.0':{name:'a',version:'1.0.0',dependencies:{b:'1'},dist:{tarball:'https://registry.npmjs.org/a/-/a-1.0.0.tgz',integrity}}}},
    b:{versions:{'1.0.0':{name:'b',version:'1.0.0',dependencies:{a:'1'},dist:{tarball:'https://registry.npmjs.org/b/-/b-1.0.0.tgz',integrity}}}},
  }
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>new Response(JSON.stringify(metadata[url.endsWith('/a')?'a':'b']))))
  await expect(resolveProjectLock(JSON.stringify({dependencies:{a:'1'}}))).rejects.toThrow('dependency cycle')
  await expect(resolveProjectLock(JSON.stringify({dependencies:{parent:'latest'}}))).rejects.toThrow('dependency spec is unsupported')
  await expect(resolveProjectLock(JSON.stringify({workspaces:['packages/*']}))).rejects.toThrow('Lockless workspace installs are unsupported')
})
test('lockless transitive archives install duplicate versions in dependency lifecycle order',async()=>{
  const manifest={name:'graph',version:'1.0.0',dependencies:{a:'1',b:'1'}},archives:Record<string,Buffer>={},metadata:Record<string,unknown>={}
  const add=(name:string,version:string,extra:Record<string,unknown>={})=>{
    const pkg={name,version,...extra},archive=gzipSync(tarArchive({'package/package.json':JSON.stringify(pkg),'package/index.js':'module.exports='+JSON.stringify(version)}))
    const tarball=`https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`
    archives[tarball]=archive
    const entry={...pkg,dist:{tarball,integrity:'sha512-'+createHash('sha512').update(archive).digest('base64')}}
    const current=metadata[name] as {name:string;versions:Record<string,unknown>}|undefined
    if(current)current.versions[version]=entry;else metadata[name]={name,versions:{[version]:entry}}
  }
  add('a','1.0.0',{dependencies:{shared:'^1'},scripts:{install:'a-install'}})
  add('b','1.0.0',{dependencies:{shared:'^2'},scripts:{install:'b-install'}})
  add('shared','1.5.0',{scripts:{install:'shared-one'}});add('shared','2.1.0',{scripts:{install:'shared-two'}})
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
    const name=Object.keys(metadata).find(name=>url.endsWith('/'+name))
    return name?new Response(JSON.stringify(metadata[name])):new Response(Uint8Array.from(archives[url]))
  }))
  const fs=new WorkspaceFiles({'/package.json':JSON.stringify(manifest),'/keep':'keep'}),before=fs.snapshot(),seen:string[]=[]
  const bad=archives['https://registry.npmjs.org/shared/-/shared-2.1.0.tgz'];archives['https://registry.npmjs.org/shared/-/shared-2.1.0.tgz']=Buffer.from('bad')
  await expect(installProject(fs,{},undefined,async()=>{})).rejects.toThrow('integrity')
  expect(fs.snapshot()).toEqual(before)
  archives['https://registry.npmjs.org/shared/-/shared-2.1.0.tgz']=bad
  expect(await installProject(fs,{},undefined,async task=>{seen.push(task.script)})).toMatchObject({installed:4})
  expect(seen.indexOf('shared-one')).toBeLessThan(seen.indexOf('a-install'))
  expect(seen.indexOf('shared-two')).toBeLessThan(seen.indexOf('b-install'))
  expect(JSON.parse(new TextDecoder().decode(fs.readFileSync('/node_modules/shared/package.json'))).version).toBe('1.5.0')
  expect(JSON.parse(new TextDecoder().decode(fs.readFileSync('/node_modules/b/node_modules/shared/package.json'))).version).toBe('2.1.0')
  fs.close()
})
test('verified archive cache recovers an aborted install while offline',async()=>{
  const fixture=npmProject(),only=fixture.lock.packages['node_modules/child']
  ;(fixture.manifest as any).dependencies={child:'1.0.0'};fixture.lock.packages={'':structuredClone(fixture.manifest),'node_modules/child':only}
  const files=new WorkspaceFiles({'/package.json':JSON.stringify(fixture.manifest),'/package-lock.json':JSON.stringify(fixture.lock),'/keep':'keep'}),before=files.snapshot(),controller=new AbortController()
  mockDownloads(fixture.archives)
  const NativeDecompressionStream=DecompressionStream
  vi.stubGlobal('DecompressionStream',class extends NativeDecompressionStream{
    constructor(format:CompressionFormat){super(format);controller.abort()}
  })
  await expect(installProject(files,{},controller.signal)).rejects.toThrow()
  expect(files.snapshot()).toEqual(before)
  vi.stubGlobal('DecompressionStream',NativeDecompressionStream)
  vi.stubGlobal('fetch',vi.fn(()=>{throw Error('offline')}))
  await expect(installProject(files)).resolves.toMatchObject({installed:1})
  expect(files.existsSync('/node_modules/child/index.js')).toBe(true)
  expect(fetch).not.toHaveBeenCalled()
  files.close()
})
test('package cache applies deterministic LRU entry and byte eviction',async()=>{
  const cache=new PackageInstallCache({archiveBytes:4,archiveEntries:2,metadataBytes:4,metadataEntries:2})
  cache.putMetadata('a','aa',2);cache.putMetadata('b','bb',2);expect(cache.getMetadata('a')).toBe('aa');cache.putMetadata('c','cc',2)
  expect(cache.getMetadata('b')).toBeUndefined();expect(cache.getMetadata('a')).toBe('aa');expect(cache.getMetadata('c')).toBe('cc')
  cache.putMetadata('large','12345',5);expect(cache.getMetadata('large')).toBeUndefined()
  let loads=0
  const load=(value:number[])=>async()=>{loads++;return Uint8Array.from(value)}
  await cache.archive('a',load([1,1]));await cache.archive('b',load([2,2]));await cache.archive('a',load([9]));await cache.archive('c',load([3,3]))
  await cache.archive('b',load([4,4]));expect(loads).toBe(4)
})
test('bounded lifecycle hooks run dependencies before root with npm cwd env and rollback on failure',async()=>{
  const fixture=bundledProject({}, {name:'child',version:'2.0.0',scripts:{preinstall:'child-pre',install:'child-install',postinstall:'child-post'}})
  const rootScripts={preinstall:'root-pre',install:'root-install',postinstall:'root-post'}
  Object.assign(fixture.manifest,{scripts:rootScripts});Object.assign(fixture.lock.packages[''],{scripts:rootScripts})
  fixture.files['/package.json']=JSON.stringify(fixture.manifest);fixture.files['/package-lock.json']=JSON.stringify(fixture.lock)
  mockDownloads(fixture.archives)
  const fs=new WorkspaceFiles(fixture.files),seen:any[]=[]
  const result=await installProject(fs,{},undefined,async task=>{
    expect(fs.existsSync(task.cwd+'/package.json')).toBe(true)
    seen.push(task)
    fs.writeFileSync('/lifecycle-'+seen.length,new TextEncoder().encode(task.script))
  })
  expect(result.ignoredScripts).toEqual([])
  expect(seen.map(task=>task.script)).toEqual(['child-pre','child-install','child-post','root-pre','root-install','root-post'])
  expect(seen[0]).toMatchObject({cwd:'/node_modules/parent/node_modules/child',event:'preinstall',env:{INIT_CWD:'/',npm_package_name:'child',npm_package_version:'2.0.0',npm_lifecycle_script:'child-pre'}})
  expect(seen[0].env.PATH.split(':')).toEqual(expect.arrayContaining(['/node_modules/parent/node_modules/child/node_modules/.bin','/node_modules/parent/node_modules/.bin','/node_modules/.bin']))
  const before=fs.snapshot()
  await expect(installProject(fs,{},undefined,async task=>{if(task.event==='install')throw Error('deliberate lifecycle failure')})).rejects.toThrow('deliberate lifecycle failure')
  expect(fs.snapshot()).toEqual(before)
  fs.close()
})
test('prepare-family hooks run for the project after dependency install hooks with npm lifecycle env',async()=>{
  const fixture=bundledProject({}, {name:'child',version:'2.0.0',scripts:{install:'child-install',prepare:'registry-prepare'}})
  const rootScripts={preinstall:'root-preinstall',install:'root-install',postinstall:'root-postinstall',prepublish:'root-prepublish',preprepare:'root-preprepare',prepare:'root-prepare',postprepare:'root-postprepare'}
  Object.assign(fixture.manifest,{scripts:rootScripts});Object.assign(fixture.lock.packages[''],{scripts:rootScripts})
  fixture.files['/package.json']=JSON.stringify(fixture.manifest);fixture.files['/package-lock.json']=JSON.stringify(fixture.lock)
  mockDownloads(fixture.archives)
  const fs=new WorkspaceFiles(fixture.files),seen:any[]=[]
  const result=await installProject(fs,{},undefined,async task=>{seen.push(task)})
  expect(result.ignoredScripts).toEqual([])
  expect(seen.map(task=>task.script)).toEqual(['child-install',...Object.values(rootScripts)])
  expect(seen.some(task=>task.script==='registry-prepare')).toBe(false)
  for(const task of seen){
    expect(task.env).toMatchObject({INIT_CWD:'/',npm_package_json:(task.cwd==='/'?'':task.cwd)+'/package.json',npm_lifecycle_event:task.event,npm_lifecycle_script:task.script})
  }
  fs.close()
})
test('an abort between prepare-family hooks restores the pre-install tree',async()=>{
  const fixture=npmProject(),scripts={preprepare:'root-preprepare',prepare:'root-prepare'}
  Object.assign(fixture.manifest,{scripts});Object.assign(fixture.lock.packages[''],{scripts})
  fixture.files['/package.json']=JSON.stringify(fixture.manifest);fixture.files['/package-lock.json']=JSON.stringify(fixture.lock)
  mockDownloads(fixture.archives)
  const fs=new WorkspaceFiles(fixture.files),before=fs.snapshot(),controller=new AbortController()
  await expect(installProject(fs,{},controller.signal,async task=>{if(task.event==='preprepare')controller.abort()})).rejects.toMatchObject({name:'AbortError'})
  expect(fs.snapshot()).toEqual(before)
  fs.close()
})
test('integrity failure leaves the original tree intact',async()=>{
  const fixture=npmProject();const fs=new WorkspaceFiles(fixture.files),before=fs.snapshot()
  mockDownloads(Object.fromEntries(Object.keys(fixture.archives).map(url=>[url,Buffer.from('bad archive')])))
  await expect(installProject(fs)).rejects.toThrow('integrity')
  expect(fs.snapshot()).toEqual(before)
})
test('host edit while downloads run rejects commit and preserves the edit',async()=>{
  const fixture=npmProject(),fs=new WorkspaceFiles(fixture.files)
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
    fs.writeFileSync('/keep.txt',new TextEncoder().encode('edited'))
    return new Response(Uint8Array.from(fixture.archives[url]))
  }))
  await expect(installProject(fs)).rejects.toThrow('ECONFLICT')
  expect(new TextDecoder().decode(fs.readFileSync('/keep.txt'))).toBe('edited')
  expect(fs.existsSync('/node_modules/stale/index.js')).toBe(true)
  expect(fs.existsSync('/node_modules/parent')).toBe(false)
})
test('archive validation rejects corruption, traversal and malformed numbers',()=>{
  expect(()=>extractTarFiles(tarArchive({'package/../../escape':'bad'}))).toThrow('Unsafe')
  const corrupt=tarArchive({'package/a':'a'});corrupt[124]=120
  expect(()=>extractTarFiles(corrupt)).toThrow('checksum')
  expect(extractTarFiles(tarArchive({'package/a':{text:'a',mode:0o751}}))[0]).toMatchObject({path:'a',mode:0o751})
  expect(extractTarFiles(tarArchive({'babel__core/package.json':'{}'}))[0].path).toBe('package.json')
})

test('npm aliases preserve their install location and report verified package identity',async()=>{
  const fixture=npmProject(),path='node_modules/child',name='@portable/child'
  const pkg=fixture.lock.packages[path]
  const archive=gzipSync(tarArchive({'package/package.json':JSON.stringify({name,version:pkg.version,main:'index.js'}),'package/index.js':'module.exports=7'}))
  pkg.name=name;pkg.resolved='https://registry.npmjs.org/@portable/child/-/child-1.0.0.tgz'
  pkg.integrity='sha512-'+createHash('sha512').update(archive).digest('base64')
  fixture.manifest.dependencies.child='npm:@portable/child@1.0.0'
  fixture.lock.packages[''].dependencies.child=fixture.manifest.dependencies.child
  fixture.archives[pkg.resolved]=archive;mockDownloads(fixture.archives)
  const files=new WorkspaceFiles({...fixture.files,'/package.json':JSON.stringify(fixture.manifest),'/package-lock.json':JSON.stringify(fixture.lock)})
  const result=await installProject(files)
  expect(result.packageAliases).toEqual([{installPath:'/node_modules/child',name,version:'1.0.0'}])
  expect(files.existsSync('/node_modules/child/index.js')).toBe(true)
  expect(files.existsSync('/node_modules/@portable/child')).toBe(false)
})

test('a downloaded package identity mismatch rejects the entire staged install',async()=>{
  const fixture=npmProject();fixture.lock.packages['node_modules/child'].name='@portable/impostor'
  mockDownloads(fixture.archives)
  const files=new WorkspaceFiles({...fixture.files,'/package-lock.json':JSON.stringify(fixture.lock)}),before=files.snapshot()
  await expect(installProject(files)).rejects.toThrow('Package name does not match lockfile')
  expect(files.snapshot()).toEqual(before)
})

test('bundled packages use their parent integrity and receive identity and executable checks',async()=>{
  const fixture=bundledProject({'package/dist/node_modules/consola/dist/basic.cjs':'module.exports="vendored"'});mockDownloads(fixture.archives)
  const fs=new WorkspaceFiles(Object.fromEntries(Object.entries(fixture.files).map(([path,value])=>['/project'+path,value])))
  expect((await installProject(fs,{cwd:'/project'})).installed).toBe(3)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(fs.realpathSync('/project/node_modules/parent/node_modules/.bin/child')).toBe('/project/node_modules/parent/node_modules/child/index.js')
  expect(new TextDecoder().decode(fs.readFileSync('/project/node_modules/parent/dist/node_modules/consola/dist/basic.cjs'))).toBe('module.exports="vendored"')
  fs.close()
})

test('bundled identity, missing manifest, scripts and undeclared paths fail atomically',async()=>{
  for(const fixture of [
    bundledProject({}, {name:'impostor',version:'2.0.0'}),
    bundledProject({}, {name:'child',version:'3.0.0'}),
    bundledProject({'package/node_modules/child/package.json':''}),
    bundledProject({},null),
    bundledProject({}, {name:'child',version:'2.0.0',scripts:{install:'untrusted'}}),
    bundledProject({'package/node_modules/other/index.js':'bad'}),
    bundledProject({'package/node_modules/child/node_modules/other/index.js':'bad'}),
  ]){
    mockDownloads(fixture.archives)
    const fs=new WorkspaceFiles(fixture.files),before=fs.snapshot()
    await expect(installProject(fs)).rejects.toThrow()
    expect(fs.snapshot()).toEqual(before)
    fs.close()
  }
})

test('bundled bytes cannot overwrite independently downloaded packages',async()=>{
  const fixture=bundledProject({'package/node_modules/child/index.js':'overwritten'})
  fixture.lock.packages['node_modules/parent/node_modules/child']=npmProject().lock.packages['node_modules/parent/node_modules/child']
  mockDownloads(fixture.archives)
  const fs=new WorkspaceFiles({...fixture.files,'/package-lock.json':JSON.stringify(fixture.lock)}),before=fs.snapshot()
  await expect(installProject(fs)).rejects.toThrow('undeclared bundled package')
  expect(fs.snapshot()).toEqual(before)
  fs.close()
})

test('bundled lock entries require an enclosing downloaded package',()=>{
  const fixture=bundledProject()
  fixture.lock.packages['node_modules/child']={version:'1.0.0',inBundle:true}
  expect(()=>planProjectInstall(JSON.stringify(fixture.manifest),JSON.stringify(fixture.lock))).toThrow('no archive owner')
})

test('nested bundled packages are validated and ignored scripts stay explicit',async()=>{
  const fixture=bundledProject({
    'package/node_modules/child/node_modules/leaf/package.json':JSON.stringify({name:'leaf',version:'1.0.0'}),
    'package/node_modules/child/node_modules/leaf/index.js':'module.exports=1',
  },{name:'child',version:'2.0.0',dependencies:{leaf:'1.0.0'},scripts:{install:'untrusted'}})
  fixture.lock.packages['node_modules/parent/node_modules/child'].dependencies={leaf:'1.0.0'}
  fixture.lock.packages['node_modules/parent/node_modules/child/node_modules/leaf']={version:'1.0.0',inBundle:true}
  mockDownloads(fixture.archives)
  const fs=new WorkspaceFiles({...fixture.files,'/package-lock.json':JSON.stringify(fixture.lock)})
  const result=await installProject(fs,{ignoreScripts:true})
  expect(result.installed).toBe(4)
  expect(result.ignoredScripts).toEqual(['/node_modules/parent/node_modules/child'])
  expect(fetch).toHaveBeenCalledTimes(2)
  fs.close()
})

test('corrupt bundled archives fail parent integrity without changing the workspace',async()=>{
  const fixture=bundledProject(),parent=fixture.lock.packages['node_modules/parent']
  fixture.archives[parent.resolved]=Buffer.from('corrupt bundled bytes')
  mockDownloads(fixture.archives)
  const fs=new WorkspaceFiles(fixture.files),before=fs.snapshot()
  await expect(installProject(fs)).rejects.toThrow('integrity')
  expect(fs.snapshot()).toEqual(before)
  fs.close()
})
