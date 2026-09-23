import {test,expect} from '@playwright/test'
import {npmProject} from '../fixtures/npm-project'
import {readFileSync} from 'node:fs'

for(const fixtureName of ['workspace-lock','workspace-versionless'])for(const guestWasm of [false,true])test(`npm-generated ${fixtureName} graph executes without registry access, guestWasm=${guestWasm}`,async({page,context})=>{
  const requests:string[]=[]
  await context.route('https://registry.npmjs.org/**',route=>{requests.push(route.request().url());return route.abort()})
  const paths=['package.json','package-lock.json','packages/app/package.json','packages/shared/package.json']
  const files={...Object.fromEntries(paths.map(path=>['/'+path,readFileSync('fixtures/'+fixtureName+'/'+path,'utf8')])),
    '/packages/app/index.js':'module.exports=require("@probe/shared")+2',
    '/packages/shared/index.js':'module.exports=40',
    '/entry.cjs':'console.log(require("@probe/app"))'}
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({files,guestWasm})=>{
    const kernel=new window.sandboxLab.WorkerKernel(files)
    try{
      const install=await kernel.install()
      const first=await kernel.runModule('/entry.cjs',{guestWasm})
      await kernel.writeText('/packages/shared/index.js','module.exports=50')
      const edited=await kernel.runModule('/entry.cjs',{guestWasm})
      await kernel.install()
      const afterInstall=await kernel.runModule('/entry.cjs',{guestWasm})
      await kernel.writeText('/packages/new/package.json',JSON.stringify({name:'@probe/new',version:'1.0.0'}))
      const before=await kernel.snapshot()
      let staleError=''
      try{await kernel.install()}catch(error){staleError=String(error)}
      return {install,first,edited,afterInstall,staleError,before,after:await kernel.snapshot()}
    }finally{kernel.close()}
  },{files,guestWasm})
  expect(result.install.installed).toBe(2)
  for(const execution of [result.first,result.edited,result.afterInstall])expect(execution.exitCode,execution.stderr).toBe(0)
  expect(result.first.stdout).toBe('42\n')
  expect(result.edited.stdout).toBe('52\n')
  expect(result.afterInstall.stdout).toBe('52\n')
  expect(result.staleError).toContain('Workspace is missing from lockfile: /packages/new')
  expect(result.after).toEqual(result.before)
  expect(requests).toEqual([])
})

test('worker installs and executes linked workspace packages with nested dependencies',async({page,context})=>{
  const fixture=npmProject()
  const manifest={...fixture.manifest,workspaces:['packages/*'],dependencies:{...fixture.manifest.dependencies,'@demo/local':'*'}}
  fixture.lock.packages['']={...manifest}
  fixture.lock.packages['packages/local']={version:'1.0.0',dependencies:{child:'2.0.0'}}
  fixture.lock.packages['node_modules/@demo/local']={resolved:'packages/local',link:true}
  fixture.lock.packages['packages/local/node_modules/child']={...fixture.lock.packages['node_modules/parent/node_modules/child']}
  const files={...fixture.files,'/package.json':JSON.stringify(manifest),'/package-lock.json':JSON.stringify(fixture.lock),
    '/packages/local/package.json':JSON.stringify({name:'@demo/local',version:'1.0.0',dependencies:{child:'2.0.0'}}),
    '/packages/local/index.js':'module.exports=require("child")+10',
    '/entry.cjs':'console.log(require("@demo/local"),require("child"))'}
  await context.route('https://registry.npmjs.org/**',route=>route.fulfill({body:fixture.archives[route.request().url()],headers:{'access-control-allow-origin':'*'}}))
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async files=>{
    const kernel=new window.sandboxLab.WorkerKernel(files)
    try{
      const installation=await kernel.install()
      const first=await kernel.runModule('/entry.cjs',{guestWasm:true})
      await kernel.writeText('/packages/local/index.js','module.exports=require("child")+20')
      const edited=await kernel.runModule('/entry.cjs',{guestWasm:true})
      await kernel.install()
      const reinstalled=await kernel.runModule('/entry.cjs',{guestWasm:true})
      return {installation,first,edited,reinstalled}
    }finally{kernel.close()}
  },files)
  expect(result.installation.installed).toBe(5)
  for(const execution of [result.first,result.edited,result.reinstalled])expect(execution.exitCode,execution.stderr).toBe(0)
  expect(result.first.stdout).toBe('12 1\n')
  expect(result.edited.stdout).toBe('22 1\n')
  expect(result.reinstalled.stdout).toBe('22 1\n')
})
