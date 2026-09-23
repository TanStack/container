import {test,expect} from '@playwright/test'

test('consumed child pipe transfers more than one MiB without retained output',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const child=`import {writeFileSync} from 'node:fs';import process from 'node:process';process.stdout.on('error',()=>{});let failure=null;try{for(let i=0;i<300;i++)await new Promise((resolve,reject)=>process.stdout.write(new Uint8Array(4096),error=>error?reject(error):resolve()))}catch(error){failure={code:error.code,message:error.message}}writeFileSync('/pipe-result.json',JSON.stringify(failure));`
    const parent=`import {spawn} from 'node:child_process';import {readFileSync} from 'node:fs';const child=spawn('node',['/child.mjs']);let bytes=0;child.stdout.on('data',chunk=>bytes+=chunk.length);await new Promise(resolve=>child.on('close',resolve));console.log(JSON.stringify({bytes,failure:JSON.parse(readFileSync('/pipe-result.json','utf8'))}));`
    const kernel=new window.sandboxLab.WorkerKernel({'/child.mjs':child,'/parent.mjs':parent})
    try{return await kernel.runModule('/parent.mjs',{timeoutMs:15000})}finally{kernel.close()}
  })
  await info.attach('pipe-volume.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({bytes:300*4096,failure:null})
})

test('unread child pipe stays bounded and cancellation closes it',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const child=`for(;;)await new Promise((resolve,reject)=>process.stdout.write(new Uint8Array(16384),error=>error?reject(error):resolve()));`
    const parent=`import {spawn} from 'node:child_process';const child=spawn('node',['/child.mjs']);child.stderr.on('data',chunk=>console.error(String(chunk)));child.on('exit',(code,signal)=>console.error('exit',code,signal));const closed=new Promise(resolve=>child.on('close',(code,signal)=>resolve({code,signal})));for(let i=0;i<100&&child.stdout.readableLength===0;i++)await new Promise(r=>setTimeout(r,5));const buffered=child.stdout.readableLength;console.error('kill',buffered,child.kill());console.log(JSON.stringify({buffered,closed:await closed}));`
    const kernel=new window.sandboxLab.WorkerKernel({'/child.mjs':child,'/parent.mjs':parent})
    try{return await kernel.runModule('/parent.mjs',{timeoutMs:15000})}finally{kernel.close()}
  })
  await info.attach('unread-pipe.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  const outcome=JSON.parse(result.stdout)
  expect(outcome.buffered).toBeGreaterThan(0)
  expect(outcome.buffered).toBeLessThanOrEqual(65536+16384)
  expect(outcome.closed).toEqual({code:null,signal:'SIGTERM'})
})
