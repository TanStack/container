import {test,expect} from '@playwright/test'

test('UTF-8 buffer conversion fits a bounded guest heap',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({
      '/main.mjs':`import {Buffer} from 'node:buffer';const text='abc😀'.repeat(150000);const size=Buffer.byteLength(text);const bytes=Buffer.from(text);console.log(JSON.stringify({size,length:bytes.length,last:[...bytes.subarray(-7)]}));`,
    })
    try{return await kernel.runModule('/main.mjs',{maxBytes:16*1024*1024,webAPIs:true})}finally{kernel.close()}
  })
  await info.attach('buffer-volume.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({size:1050000,length:1050000,last:[97,98,99,240,159,152,128]})
})
