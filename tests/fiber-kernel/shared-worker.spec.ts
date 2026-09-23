import {test,expect} from '@playwright/test'

test('experimental workers share startup and message buffers without copying',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({
      '/main.mjs':`import {Worker} from 'node:worker_threads';
const startup=new SharedArrayBuffer(16);new Int32Array(startup)[0]=41;
const worker=new Worker(new URL('./child.mjs',import.meta.url),{workerData:{startup,alias:startup,view:new Int32Array(startup)}});
const exit=new Promise(resolve=>worker.on('exit',resolve));
const next=()=>new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)});
const ready=await next();
if(ready!==42||new Int32Array(startup)[0]!==42)throw Error('Startup bytes were copied');
const buffer=new SharedArrayBuffer(16);new Int32Array(buffer)[1]=70;
const response=next();worker.postMessage({buffer,alias:buffer,view:new Int32Array(buffer,4,1)});
const received=await response;
if(new Int32Array(buffer)[1]!==73||received.buffer!==received.alias||received.view.buffer!==received.buffer||received.view.byteOffset!==4)throw Error('Message aliases lost');
Atomics.add(received.view,0,1);
if(new Int32Array(buffer)[1]!==74)throw Error('Reply copied shared bytes');
console.log(JSON.stringify({startup:ready,message:new Int32Array(buffer)[1],exit:await exit}));`,
      '/child.mjs':`import {parentPort,workerData} from 'node:worker_threads';
if(workerData.startup!==workerData.alias||workerData.view.buffer!==workerData.startup)throw Error('Startup aliases lost');
Atomics.add(workerData.view,0,1);parentPort.postMessage(workerData.view[0]);
parentPort.on('message',message=>{
 if(message.buffer!==message.alias||message.view.buffer!==message.buffer)throw Error('Message aliases lost');
 Atomics.add(message.view,0,3);parentPort.postMessage(message);parentPort.close();
});`,
    },{experimentalFibers:true,timeoutMs:15000})
    try{return await kernel.runModule('/main.mjs',{webAPIs:true,timeoutMs:15000})}finally{kernel.close()}
  })
  await info.attach('shared-worker.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({startup:42,message:74,exit:0})
})

for(const queued of [false,true])test(`shared MessagePort delivery ${queued?'after creator exit':'to waiting receiver'}`,async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async queued=>{
    const kernel=new window.sandboxLab.WorkerKernel({
      '/main.mjs':`import {Worker,MessageChannel,receiveMessageOnPort} from 'node:worker_threads';
const {port1,port2}=new MessageChannel();
const worker=new Worker(new URL('./child.mjs',import.meta.url),{workerData:{port:port2},transferList:[port2]});
const exit=new Promise((resolve,reject)=>{worker.on('exit',resolve);worker.on('error',reject)});
${queued?`const code=await exit;const {message}=receiveMessageOnPort(port1);`:`const message=await new Promise(resolve=>port1.once('message',resolve));const code=await exit;`}
if(message.buffer!==message.alias||message.view.buffer!==message.buffer)throw Error('Port aliases lost');
const before=Atomics.add(message.view,0,1);port1.close();
console.log(JSON.stringify({before,after:message.view[0],code}));`,
      '/child.mjs':`import {workerData} from 'node:worker_threads';
const buffer=new SharedArrayBuffer(16),view=new Int32Array(buffer);view[0]=81;
workerData.port.postMessage({buffer,alias:buffer,view});workerData.port.close();`,
    },{experimentalFibers:true,timeoutMs:15000})
    try{return await kernel.runModule('/main.mjs',{webAPIs:true,timeoutMs:15000})}finally{kernel.close()}
  },queued)
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({before:81,after:82,code:0})
})
