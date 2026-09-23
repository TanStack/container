import {test,expect} from '@playwright/test'

test('a parent process can request an ephemeral HTTP server owned by a worker',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const files={
      '/parent.mjs':`import {Worker} from 'node:worker_threads';import http from 'node:http';const worker=new Worker('/child.mjs');const address=await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)});const body=await new Promise((resolve,reject)=>http.get(address,response=>{let text='';response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve(text))}).on('error',reject));console.log(JSON.stringify({address,body}));await worker.terminate()`,
      '/child.mjs':`import {parentPort} from 'node:worker_threads';import http from 'node:http';const server=http.createServer((_request,response)=>response.end('worker-http'));server.listen(0,'127.0.0.1',()=>parentPort.postMessage(server.address()))`,
    }
    const kernel=new window.sandboxLab.WorkerKernel(files,{maxBytes:128*1024*1024,workerMaxBytes:128*1024*1024})
    try{return await kernel.runModule('/parent.mjs',{guestWasm:true,webAPIs:true,timeoutMs:15000})}finally{kernel.close()}
  })
  expect(result.exitCode,result.stderr).toBe(0)
  const output=JSON.parse(result.stdout)
  expect(output.address).toMatchObject({address:'127.0.0.1',family:'IPv4'})
  expect(output.address.port).toBeGreaterThan(0)
  expect(output.body).toBe('worker-http')
})
