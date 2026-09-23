import {test,expect} from '@playwright/test'

function graphFiles(){
  const root={name:'workspace-root',version:'1.0.0',workspaces:['packages/*'],dependencies:{'@graph/app':'workspace:*','@graph/tool':'workspace:^'}}
  const app={name:'@graph/app',version:'1.0.0',dependencies:{'@graph/tool':'workspace:^'},scripts:{install:'workspace-log app'}}
  const tool={name:'@graph/tool',version:'1.2.3',main:'index.js',bin:{'workspace-log':'cli.cjs'},scripts:{install:'workspace-log tool'}}
  const lock={name:root.name,version:root.version,lockfileVersion:3,packages:{
    '':root,
    'packages/app':{version:app.version,dependencies:app.dependencies,scripts:app.scripts},
    'packages/tool':{version:tool.version,bin:tool.bin,scripts:tool.scripts},
    'node_modules/@graph/app':{resolved:'packages/app',link:true},
    'node_modules/@graph/tool':{resolved:'packages/tool',link:true},
  }}
  return {'/package.json':JSON.stringify(root),'/package-lock.json':JSON.stringify(lock),
    '/packages/app/package.json':JSON.stringify(app),'/packages/app/index.js':'module.exports=require("@graph/tool")+2',
    '/packages/tool/package.json':JSON.stringify(tool),'/packages/tool/index.js':'module.exports=40',
    '/packages/tool/cli.cjs':'#!/usr/bin/env node\nrequire("fs").appendFileSync("/lifecycle-order",process.argv.at(-1)+"\\n")',
    '/entry.cjs':'console.log(require("@graph/app"))'}
}

test('workspace dependency graph links bins, orders lifecycle and rolls back cycles',async({page,context})=>{
  const requests:string[]=[]
  await context.route('https://registry.npmjs.org/**',route=>{requests.push(route.request().url());return route.abort()})
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async files=>{
    const kernel=new window.sandboxLab.WorkerKernel(files)
    try{
      await kernel.install()
      const execution=await kernel.runModule('/entry.cjs',{guestWasm:true})
      const order=await kernel.readText('/lifecycle-order')
      await kernel.writeText('/packages/tool/index.js','module.exports=50')
      const edited=await kernel.runModule('/entry.cjs',{guestWasm:true})
      await kernel.install()
      const reinstalled=await kernel.runModule('/entry.cjs',{guestWasm:true})
      const lock=JSON.parse(await kernel.readText('/package-lock.json'))
      const tool=JSON.parse(await kernel.readText('/packages/tool/package.json'))
      tool.dependencies={'@graph/app':'workspace:*'};lock.packages['packages/tool'].dependencies=tool.dependencies
      await kernel.writeText('/packages/tool/package.json',JSON.stringify(tool));await kernel.writeText('/package-lock.json',JSON.stringify(lock))
      const before=await kernel.snapshot()
      let error=''
      try{await kernel.install()}catch(failure){error=String(failure)}
      return {execution,edited,reinstalled,order,error,before,after:await kernel.snapshot()}
    }finally{kernel.close()}
  },graphFiles())
  expect(result.execution.exitCode,result.execution.stderr).toBe(0)
  expect(result.execution.stdout).toBe('42\n')
  expect(result.edited.stdout).toBe('52\n')
  expect(result.reinstalled.stdout).toBe('52\n')
  expect(result.order).toBe('tool\napp\n')
  expect(result.error).toContain('Workspace dependency cycle')
  expect(result.after).toEqual(result.before)
  expect(requests).toEqual([])
})
