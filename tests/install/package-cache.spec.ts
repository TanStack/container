import {test,expect} from '@playwright/test'
import {npmProject} from '../fixtures/npm-project'

test('verified package cache supports an offline repeat install in a new kernel',async({page,context})=>{
  const fixture=npmProject(),online:string[]=[],offline:string[]=[]
  await context.route('https://registry.npmjs.org/**',route=>{online.push(route.request().url());return route.fulfill({body:fixture.archives[route.request().url()],headers:{'access-control-allow-origin':'*'}})})
  await page.goto('/sandbox.html')
  await page.evaluate(files=>{(window as any).cacheKernel=new window.sandboxLab.WorkerKernel(files)},fixture.files)
  const first=await page.evaluate(async()=>{
    const kernel=(window as any).cacheKernel
    try{return await kernel.install()}finally{kernel.close();delete (window as any).cacheKernel}
  })
  await context.unroute('https://registry.npmjs.org/**')
  await context.route('https://registry.npmjs.org/**',route=>{offline.push(route.request().url());return route.abort()})
  const second=await page.evaluate(async files=>{
    const kernel=new window.sandboxLab.WorkerKernel(files)
    try{return {install:await kernel.install(),execution:await kernel.runModule('/entry.cjs',{guestWasm:true})}}
    finally{kernel.close()}
  },fixture.files)
  expect(first.installed).toBe(3);expect(second.install.installed).toBe(3)
  expect(second.execution.exitCode,second.execution.stderr).toBe(0);expect(second.execution.stdout).toBe('42 1\n')
  expect(online).toHaveLength(3);expect(offline).toEqual([])
})
