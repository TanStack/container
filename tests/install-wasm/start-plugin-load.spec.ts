import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'

const files=Object.fromEntries(['package.json','package-lock.json'].map(name=>['/project/'+name,readFileSync('fixtures/install-start-wasm/'+name,'utf8')]))
files['/project/vite.config.ts']=readFileSync('fixtures/start-basic/vite.config.ts','utf8')
for(const target of ['@babel/core','@tanstack/react-start/plugin/vite','@vitejs/plugin-react','./vite.config.ts'])test(`installed Start config import: ${target}`,async({page},info)=>{
  if(process.env.TERMINATION_COOPERATIVE==='1'){
    const path='public/quickjs-als-asyncify-wasm-o2-generator-queue-yield-profile-poll4096-cooperative'+(process.env.COOPERATIVE_WASM_BATCH?'-batch'+process.env.COOPERATIVE_WASM_BATCH:'')+(process.env.COOPERATIVE_ASSIGNMENTS==='1'?'-assignments':'')+'/build.json'
    await info.attach('plugin-engine.json',{body:readFileSync(path),contentType:'application/json'})
  }
  const hostErrors:string[]=[]
  page.on('console',message=>{if(message.type()==='error')hostErrors.push(message.text())})
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({files,target})=>{
    const kernel=new window.sandboxLab.WorkerKernel(files,{cooperative:true,maxBytes:256*1024*1024,workspace:{maxBytes:128*1024*1024}})
    try{
      await kernel.install({cwd:'/project',ignoreScripts:true})
      await kernel.writeText('/project/probe.mjs',`await import(${JSON.stringify(target)});console.log('IMPORT_COMPLETE')`)
      return await kernel.runModule('/project/probe.mjs',{guestWasm:true,webAPIs:true,maxBytes:256*1024*1024,timeoutMs:30000,diagnostics:true})
    }finally{kernel.close()}
  },{files,target})
  await info.attach('plugin-import.json',{body:JSON.stringify({target,result,hostErrors}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toContain('IMPORT_COMPLETE')
})
