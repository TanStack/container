import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'

test('ordinary Start dependency tree installs and loads Vite in the guest',async({page},info)=>{
  const files=Object.fromEntries(['package.json','package-lock.json'].map(name=>['/'+name,readFileSync('fixtures/install-start/'+name,'utf8')]))
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async files=>{
    const kernel=new window.sandboxLab.WorkerKernel(files,{workspace:{maxBytes:128*1024*1024}})
    let stage='install'
    try{
      const installation=await kernel.install({ignoreScripts:true})
      stage='load-vite'
      await kernel.writeText('/probe.mjs','import {version} from "vite";console.log(version)')
      const execution=await kernel.runModule('/probe.mjs',{guestWasm:true,webAPIs:true,maxBytes:64*1024*1024,timeoutMs:30000})
      return {stage,installation,execution}
    }catch(error){return {stage,error:String(error)}}finally{kernel.close()}
  },files)
  await info.attach('start-install.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.error,JSON.stringify(result)).toBeUndefined()
  expect(result.execution?.exitCode,result.execution?.stderr).toBe(0)
  expect(result.execution?.stdout).toBe('7.3.6\n')
})
