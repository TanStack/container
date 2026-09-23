import {test,expect} from '@playwright/test'
import {createServer} from 'vite'
import {resolve} from 'node:path'

test('fresh lab optimizer cache starts the VM without stale dependency requests',async({page},info)=>{
  const server=await createServer({configFile:resolve('vite.config.ts'),cacheDir:info.outputPath('vite-cache'),server:{host:'127.0.0.1',port:0,strictPort:false}})
  const failures:{url:string,status:number}[]=[]
  page.on('response',response=>{if(response.status()>=400&&response.url().includes('/deps/'))failures.push({url:response.url(),status:response.status()})})
  try{
    await server.listen()
    const address=server.httpServer!.address()
    if(!address||typeof address==='string')throw Error('Missing lab port')
    // Match the test server health check, which visits the original lab first.
    await fetch(`http://127.0.0.1:${address.port}/`)
    await page.goto(`http://127.0.0.1:${address.port}/sandbox.html`)
    const result=await page.evaluate(async()=>{
      const kernel=new window.sandboxLab.WorkerKernel({'/main.cjs':`const fs=require('node:fs');fs.mkdirSync('/private',0o700);console.log(fs.statSync('/private').mode)`})
      try{
        const compiler='/src/compiler/compile.ts',installer='/src/npm/project.ts'
        const [result]=await Promise.all([kernel.runModule('/main.cjs'),import(compiler),import(installer)])
        return result
      }finally{kernel.close()}
    })
    await info.attach('cold-start.json',{body:JSON.stringify({result,failures}),contentType:'application/json'})
    expect(result.exitCode,result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe(String(0o40700))
    expect(failures).toEqual([])
  }finally{await server.close()}
})
