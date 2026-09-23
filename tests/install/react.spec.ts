import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'

test('published React packages install from an npm-generated lockfile and stream SSR',async({page},info)=>{
  const files=Object.fromEntries(['package.json','package-lock.json','entry.mjs'].map(name=>['/'+name,readFileSync('fixtures/install-react/'+name,'utf8')]))
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async files=>{
    const kernel=new window.sandboxLab.WorkerKernel(files)
    try{
      const installation=await kernel.install()
      const execution=await kernel.runModule('/entry.mjs',{guestWasm:true,webAPIs:true,maxBytes:32*1024*1024,timeoutMs:10000})
      return {installation,execution}
    }finally{kernel.close()}
  },files)
  await info.attach('registry-react.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.installation.installed).toBe(3)
  expect(result.installation.ignoredScripts).toEqual([])
  expect(result.execution.exitCode,result.execution.stderr).toBe(0)
  expect(result.execution.stdout).toBe('<h1>Installed in the worker</h1>\n')
})
