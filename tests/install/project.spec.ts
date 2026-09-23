import {test,expect} from '@playwright/test'
import {npmProject} from '../fixtures/npm-project'

test('installation respects owner workspace quotas and preserves the original tree',async({page,context})=>{
  const fixture=npmProject()
  await context.route('https://registry.npmjs.org/**',route=>route.fulfill({body:fixture.archives[route.request().url()],headers:{'access-control-allow-origin':'*'}}))
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async files=>{
    const initialBytes=Object.values(files).reduce((sum,text)=>sum+new TextEncoder().encode(text).length,0)
    const kernel=new window.sandboxLab.WorkerKernel(files,{workspace:{maxBytes:initialBytes+10}})
    try{
      const before=await kernel.snapshot()
      let error=''
      try{await kernel.install()}catch(failure){error=String(failure)}
      return {error,before,after:await kernel.snapshot()}
    }finally{kernel.close()}
  },fixture.files)
  expect(result.error).toContain('ENOSPC')
  expect(result.after).toEqual(result.before)
})

test('ordinary npm tree installs in the worker and executes with nested resolution',async({page,context},info)=>{
  const fixture=npmProject()
  await context.route('https://registry.npmjs.org/**',route=>route.fulfill({body:fixture.archives[route.request().url()],headers:{'access-control-allow-origin':'*'}}))
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async files=>{
    const kernel=new window.sandboxLab.WorkerKernel(files)
    try{
      const installation=await kernel.install()
      const first=await kernel.runModule('/entry.cjs',{guestWasm:true})
      await kernel.writeText('/node_modules/parent/node_modules/child/index.js','module.exports=3')
      const edited=await kernel.runModule('/entry.cjs',{guestWasm:true})
      await kernel.install()
      const restored=await kernel.runModule('/entry.cjs',{guestWasm:true})
      return {installation,first,edited,restored,snapshot:await kernel.snapshot()}
    }finally{kernel.close()}
  },fixture.files)
  await info.attach('installation.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.installation.installed).toBe(3)
  for(const execution of [result.first,result.edited,result.restored])expect(execution.exitCode,execution.stderr).toBe(0)
  expect(result.first.stdout).toBe('42 1\n');expect(result.edited.stdout).toBe('43 1\n');expect(result.restored.stdout).toBe('42 1\n')
  expect(result.snapshot.files['/node_modules/stale/index.js']).toBeUndefined()
})

for(const mode of ['conflict','cancel','signal','agent-signal','integrity'] as const){
  test(`failed worker install preserves files and recovers: ${mode}`,async({page,context})=>{
    const fixture=npmProject()
    let release!:()=>void,started!:()=>void
    const gate=new Promise<void>(resolve=>release=resolve),requested=new Promise<void>(resolve=>started=resolve)
    let failing=true
    await context.route('https://registry.npmjs.org/**',async route=>{
      if(failing){started();await gate}
      await route.fulfill({body:failing&&mode==='integrity'?Buffer.from('bad'):fixture.archives[route.request().url()],headers:{'access-control-allow-origin':'*'}}).catch(()=>{})
    })
    await page.goto('/sandbox.html')
    await page.evaluate(async({files,mode})=>{
      const state=window as any
      state.installKernel=new window.sandboxLab.WorkerKernel(files)
      state.installController=new AbortController()
      let operation
      if(mode==='agent-signal'){
        const moduleURL='/src/sdk/agent-session.ts'
        const {AgentSession}=await import(moduleURL) as typeof import('../../src/sdk/agent-session')
        operation=new AgentSession({}, {kernel:state.installKernel}).install({},state.installController.signal)
      }else operation=state.installKernel.install({},mode==='signal'?state.installController.signal:undefined)
      state.installResult=operation.then(()=>'',(error:unknown)=>String(error))
    },{files:fixture.files,mode})
    await requested
    if(mode==='conflict')await page.evaluate(()=> (window as any).installKernel.writeText('/keep.txt','edited'))
    if(mode==='cancel')await page.evaluate(()=> (window as any).installKernel.cancelInstall())
    if(mode==='signal'||mode==='agent-signal'){
      const error=await page.evaluate(async()=>{
        const state=window as any
        state.installController.abort(new Error('User cancelled installation'))
        return await state.installResult
      })
      expect(error).toContain('User cancelled installation')
    }
    release()
    const failure=await page.evaluate(async()=>{
      const state=window as any
      return {error:await state.installResult,snapshot:await state.installKernel.snapshot(),text:await state.installKernel.readText('/keep.txt')}
    })
    expect(failure.error).toMatch(mode==='conflict'?/ECONFLICT/:mode==='integrity'?/integrity/i:/cancel/i)
    expect(failure.snapshot.files['/node_modules/stale/index.js']).toBeDefined()
    expect(failure.snapshot.files['/node_modules/parent/index.js']).toBeUndefined()
    expect(failure.text).toBe(mode==='conflict'?'edited':'keep')
    failing=false
    const recovery=await page.evaluate(async()=>{
      const kernel=(window as any).installKernel
      try{await kernel.install();return await kernel.runModule('/entry.cjs',{guestWasm:true})}finally{kernel.close()}
    })
    expect(recovery.exitCode,recovery.stderr).toBe(0);expect(recovery.stdout).toBe('42 1\n')
  })
}
