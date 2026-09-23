import {afterEach,expect,test,vi} from 'vitest'
import {npmProject} from './fixtures/npm-project'
import {installProject} from '../src/npm/project'
import {WorkspaceFiles} from '../src/sandbox/files'
import {readFileSync} from 'node:fs'

afterEach(()=>vi.unstubAllGlobals())
test('versionless npm workspaces preserve absent versions and reject stale version metadata',async()=>{
  const paths=['package.json','package-lock.json','packages/app/package.json','packages/shared/package.json']
  const files=Object.fromEntries(paths.map(path=>['/'+path,readFileSync('fixtures/workspace-versionless/'+path,'utf8')]))
  const fs=new WorkspaceFiles(files)
  vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Unexpected registry request')}))
  try{
    expect((await installProject(fs)).installed).toBe(2)
    expect(JSON.parse(new TextDecoder().decode(fs.readFileSync('/node_modules/@probe/shared/package.json'))).version).toBeUndefined()
    fs.writeFileSync('/packages/shared/package.json',new TextEncoder().encode(JSON.stringify({name:'@probe/shared',private:true,version:'1.0.0'})))
    const before=fs.snapshot()
    await expect(installProject(fs)).rejects.toThrow('identity does not match lockfile')
    expect(fs.snapshot()).toEqual(before)
    expect(fetch).not.toHaveBeenCalled()
  }finally{fs.close()}
})
test('workspace discovery rejects new members and duplicates before downloads',async()=>{
  for(const name of ['new-package','@demo/local']){
    const fixture=workspace(),fs=new WorkspaceFiles({...fixture.files,'/packages/new/package.json':JSON.stringify({name,version:'1.0.0'})}),before=fs.snapshot()
    try{await expect(installProject(fs)).rejects.toThrow();expect(fs.snapshot()).toEqual(before);expect(fetch).not.toHaveBeenCalled()}finally{fs.close()}
  }
})
test('workspace exclusions, braces and explicit dot directories are checked',async()=>{
  for(const patterns of [['packages/{local,new}'],['packages/*','!packages/new'],['packages/*','!packages/new','packages/new'],['packages/local','.hidden/*']]){
    const fixture=workspace(),manifest=JSON.parse(fixture.files['/package.json'])
    manifest.workspaces=patterns;fixture.lock.packages[''].workspaces=patterns
    const fs=new WorkspaceFiles({...fixture.files,'/package.json':JSON.stringify(manifest),'/package-lock.json':JSON.stringify(fixture.lock),
      '/packages/new/package.json':'{"name":"new","version":"1.0.0"}','/.hidden/new/package.json':'{"name":"hidden","version":"1.0.0"}'})
    try{
      if(patterns.length===2&&patterns[1]==='!packages/new')expect((await installProject(fs)).installed).toBe(5)
      else await expect(installProject(fs)).rejects.toThrow('missing from lockfile')
    }finally{fs.close()}
  }
})
test('npm-generated workspace lock installs without registry access and rejects stale declarations',async()=>{
  const paths=['package.json','package-lock.json','packages/app/package.json','packages/shared/package.json']
  const files=Object.fromEntries(paths.map(path=>['/'+path,readFileSync('fixtures/workspace-lock/'+path,'utf8')]))
  const fs=new WorkspaceFiles(files)
  vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Unexpected registry access')}))
  try{
    expect((await installProject(fs)).installed).toBe(2)
    expect(fs.realpathSync('/node_modules/@probe/app')).toBe('/packages/app')
    expect(fs.realpathSync('/node_modules/@probe/shared')).toBe('/packages/shared')
    const manifest=JSON.parse(files['/package.json']);manifest.workspaces=['other/*']
    fs.writeFileSync('/package.json',new TextEncoder().encode(JSON.stringify(manifest)))
    const before=fs.snapshot()
    await expect(installProject(fs)).rejects.toThrow('out of sync with package.json: workspaces')
    expect(fs.snapshot()).toEqual(before)
    expect(fetch).not.toHaveBeenCalled()
  }finally{fs.close()}
})
function workspace(){
  const fixture=npmProject()
  const manifest={...fixture.manifest,workspaces:['packages/*'],dependencies:{...fixture.manifest.dependencies,'@demo/local':'*'}}
  const local={name:'@demo/local',version:'1.0.0',dependencies:{child:'2.0.0'},bin:{local:'index.js'}}
  const lock=fixture.lock
  lock.packages['']={...manifest}
  lock.packages['packages/local']={version:local.version,dependencies:{...local.dependencies},bin:local.bin}
  lock.packages['node_modules/@demo/local']={resolved:'packages/local',link:true}
  lock.packages['packages/local/node_modules/child']={...lock.packages['node_modules/parent/node_modules/child']}
  const files={...fixture.files,'/package.json':JSON.stringify(manifest),'/package-lock.json':JSON.stringify(lock),
    '/packages/local/package.json':JSON.stringify(local),'/packages/local/index.js':'module.exports=require("child")',
    '/packages/local/node_modules/stale/index.js':'stale'}
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>new Response(Uint8Array.from(fixture.archives[url]))))
  return {files,lock,local}
}
function workspaceGraph(){
  const fixture=workspace(),root=JSON.parse(fixture.files['/package.json'])
  const app:Record<string,any>=fixture.local,tool={name:'@demo/tool',version:'1.2.3',bin:{'workspace-tool':'cli.js'},scripts:{install:'tool-install'}}
  root.dependencies['@demo/tool']='workspace:^';app.dependencies['@demo/tool']='workspace:^';Object.assign(app,{scripts:{install:'app-install'}})
  fixture.lock.packages['']={...root}
  fixture.lock.packages['packages/local']={...fixture.lock.packages['packages/local'],dependencies:{...app.dependencies},scripts:app.scripts}
  fixture.lock.packages['packages/tool']={version:tool.version,bin:tool.bin,scripts:tool.scripts}
  fixture.lock.packages['node_modules/@demo/tool']={resolved:'packages/tool',link:true}
  return {...fixture,local:app,files:{...fixture.files,'/package.json':JSON.stringify(root),'/package-lock.json':JSON.stringify(fixture.lock),'/packages/local/package.json':JSON.stringify(app),'/packages/tool/package.json':JSON.stringify(tool),'/packages/tool/cli.js':'#!/usr/bin/env node'}}
}
test('locked workspaces retain nested versions, executable links and live source edits',async()=>{
  const fixture=workspace(),fs=new WorkspaceFiles(Object.fromEntries(Object.entries(fixture.files).map(([path,value])=>['/project'+path,value])))
  try{
    expect((await installProject(fs,{cwd:'/project'})).installed).toBe(5)
    expect(fs.realpathSync('/project/node_modules/@demo/local')).toBe('/project/packages/local')
    expect(fs.realpathSync('/project/node_modules/.bin/local')).toBe('/project/packages/local/index.js')
    expect(fs.existsSync('/project/packages/local/node_modules/stale')).toBe(false)
    expect(JSON.parse(new TextDecoder().decode(fs.readFileSync('/project/packages/local/node_modules/child/package.json'))).version).toBe('2.0.0')
    fs.writeFileSync('/project/packages/local/index.js',new TextEncoder().encode('module.exports=42'))
    expect(new TextDecoder().decode(fs.readFileSync('/project/node_modules/@demo/local/index.js'))).toBe('module.exports=42')
    expect((await installProject(fs,{cwd:'/project'})).installed).toBe(5)
    expect(new TextDecoder().decode(fs.readFileSync('/project/node_modules/@demo/local/index.js'))).toBe('module.exports=42')
  }finally{fs.close()}
})
test('workspace graph links bins and runs dependency lifecycle before dependents',async()=>{
  const fixture=workspaceGraph(),fs=new WorkspaceFiles(fixture.files),seen:string[]=[]
  try{
    await installProject(fs,{},undefined,async task=>{
      seen.push(task.script)
      expect(fs.realpathSync('/node_modules/.bin/workspace-tool')).toBe('/packages/tool/cli.js')
    })
    expect(seen).toEqual(['tool-install','app-install'])
  }finally{fs.close()}
})
test('workspace prepare-family hooks follow workspace dependency order',async()=>{
  const fixture=workspaceGraph(),tool=JSON.parse(fixture.files['/packages/tool/package.json']),app=JSON.parse(fixture.files['/packages/local/package.json'])
  tool.scripts={prepare:'tool-prepare'};app.scripts={preprepare:'app-preprepare',prepare:'app-prepare',postprepare:'app-postprepare'}
  fixture.lock.packages['packages/tool'].scripts=tool.scripts;fixture.lock.packages['packages/local'].scripts=app.scripts
  fixture.files['/packages/tool/package.json']=JSON.stringify(tool);fixture.files['/packages/local/package.json']=JSON.stringify(app);fixture.files['/package-lock.json']=JSON.stringify(fixture.lock)
  const fs=new WorkspaceFiles(fixture.files),seen:string[]=[]
  try{
    await installProject(fs,{},undefined,async task=>{seen.push(task.script)})
    expect(seen).toEqual(['tool-prepare','app-preprepare','app-prepare','app-postprepare'])
  }finally{fs.close()}
})
test('workspace cycles, ranges and phantom locked members fail atomically',async()=>{
  for(const mutate of [
    (fixture:ReturnType<typeof workspaceGraph>)=>{const tool=JSON.parse(fixture.files['/packages/tool/package.json']);tool.dependencies={'@demo/local':'workspace:*'};fixture.files['/packages/tool/package.json']=JSON.stringify(tool);fixture.lock.packages['packages/tool'].dependencies=tool.dependencies},
    (fixture:ReturnType<typeof workspaceGraph>)=>{fixture.local.dependencies['@demo/tool']='workspace:^2';fixture.lock.packages['packages/local'].dependencies['@demo/tool']='workspace:^2';fixture.files['/packages/local/package.json']=JSON.stringify(fixture.local)},
    (fixture:ReturnType<typeof workspaceGraph>)=>{fixture.lock.packages['packages/ghost']={name:'@demo/ghost',version:'1.0.0'};fixture.lock.packages['node_modules/@demo/ghost']={resolved:'packages/ghost',link:true};fixture.files['/package-lock.json']=JSON.stringify(fixture.lock)},
  ]){
    const fixture=workspaceGraph();mutate(fixture);fixture.files['/package-lock.json']=JSON.stringify(fixture.lock)
    const fs=new WorkspaceFiles(fixture.files),before=fs.snapshot()
    try{await expect(installProject(fs,{},undefined,async()=>{})).rejects.toThrow();expect(fs.snapshot()).toEqual(before)}finally{fs.close()}
  }
})
test('unsafe links, stale local metadata and lifecycle scripts fail without changing files',async()=>{
  for(const change of [
    (x:ReturnType<typeof workspace>)=>{x.lock.packages['node_modules/@demo/local'].resolved='../outside'},
    (x:ReturnType<typeof workspace>)=>{x.lock.packages['node_modules/@demo/local'].resolved='/outside'},
    (x:ReturnType<typeof workspace>)=>{x.local.version='9.0.0'},
    (x:ReturnType<typeof workspace>)=>{x.local.dependencies.child='9.0.0'},
    (x:ReturnType<typeof workspace>)=>{Object.assign(x.local,{scripts:{prepare:'untrusted'}})},
  ]){
    const fixture=workspace();change(fixture)
    const fs=new WorkspaceFiles({...fixture.files,'/package-lock.json':JSON.stringify(fixture.lock),'/packages/local/package.json':JSON.stringify(fixture.local)}),before=fs.snapshot()
    try{await expect(installProject(fs)).rejects.toThrow();expect(fs.snapshot()).toEqual(before)}finally{fs.close()}
  }
})
test('local directory symlinks cannot redirect an install into a sibling project',async()=>{
  const fixture=workspace(),fs=new WorkspaceFiles(fixture.files)
  fs.mkdirSync('/outside',true)
  fs.writeFileSync('/outside/package.json',new TextEncoder().encode(JSON.stringify(fixture.local)))
  fs.rmSync('/packages/local',{recursive:true})
  fs.symlinkSync('/outside','/packages/local')
  const before=fs.snapshot()
  try{await expect(installProject(fs)).rejects.toThrow('must not contain symlinks');expect(fs.snapshot()).toEqual(before)}finally{fs.close()}
})
