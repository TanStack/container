import {test,expect} from '@playwright/test'

for(const guestWasm of [false,true])test(`Response consumes Node and Web streams (${guestWasm?'WASM bridge':'default'})`,async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async guestWasm=>{
    const code=`import {Readable} from 'node:stream';const node=Readable.from(['<html>','hello','</html>']);const web=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('web'));c.close()}});console.log(JSON.stringify({node:await new Response(node).text(),web:await new Response(web).text()}));`
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':code})
    try{return await kernel.runModule('/main.mjs',{guestWasm,webAPIs:true,timeoutMs:10000})}finally{kernel.close()}
  },guestWasm)
  await info.attach('response-stream.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({node:'<html>hello</html>',web:'web'})
})
