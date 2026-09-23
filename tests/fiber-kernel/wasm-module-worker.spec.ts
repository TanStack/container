import {test,expect} from '@playwright/test'

const addModule=[0,97,115,109,1,0,0,0,1,7,1,96,2,127,127,1,127,3,2,1,0,7,7,1,3,97,100,100,0,0,10,9,1,7,0,32,0,32,1,106,11]

test('WASM Module worker data and round trips preserve aliases and compiled input bytes',async({page},info)=>{
  expect(WebAssembly.validate(new Uint8Array(addModule))).toBe(true)
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async bytes=>{
    const kernel=new window.sandboxLab.WorkerKernel({
      '/main.mjs':`import {Worker} from 'node:worker_threads';
const input=new Uint8Array(${JSON.stringify(bytes)}),module=new WebAssembly.Module(input);
input.fill(0);
const worker=new Worker(new URL('./child.mjs',import.meta.url),{workerData:{module,alias:module}});
const exit=new Promise((resolve,reject)=>{worker.on('exit',resolve);worker.on('error',reject)});
const next=()=>new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)});
const first=await next();
if(first.module!==first.alias||!(first.module instanceof WebAssembly.Module))throw Error('Reply module aliases lost');
const firstValue=new WebAssembly.Instance(first.module).exports.add(20,22);
const pending=next();worker.postMessage({module:first.module,alias:first.module});
const second=await pending;
console.log(JSON.stringify({startup:first.value,roundtrip:firstValue,second,exit:await exit}));`,
      '/child.mjs':`import {parentPort,workerData} from 'node:worker_threads';
if(workerData.module!==workerData.alias||!(workerData.module instanceof WebAssembly.Module))throw Error('Worker data module aliases lost');
const value=new WebAssembly.Instance(workerData.module).exports.add(40,2);
parentPort.postMessage({module:workerData.module,alias:workerData.module,value});
parentPort.on('message',message=>{
 if(message.module!==message.alias||!(message.module instanceof WebAssembly.Module))throw Error('Message module aliases lost');
 parentPort.postMessage(new WebAssembly.Instance(message.module).exports.add(21,21));parentPort.close();
});`,
    },{experimentalFibers:true,timeoutMs:20000})
    try{return await kernel.runModule('/main.mjs',{guestWasm:true,webAPIs:true,timeoutMs:20000})}finally{kernel.close()}
  },addModule)
  await info.attach('wasm-module-worker.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({startup:42,roundtrip:42,second:42,exit:0})
})

test('queued MessagePort module remains usable after its creator exits',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async bytes=>{
    const kernel=new window.sandboxLab.WorkerKernel({
      '/main.mjs':`import {Worker,MessageChannel,receiveMessageOnPort} from 'node:worker_threads';
const {port1,port2}=new MessageChannel();
const worker=new Worker(new URL('./child.mjs',import.meta.url),{workerData:port2,transferList:[port2]});
const exit=await new Promise((resolve,reject)=>{worker.on('exit',resolve);worker.on('error',reject)});
const {message}=receiveMessageOnPort(port1);
if(message.module!==message.alias||!(message.module instanceof WebAssembly.Module))throw Error('Queued module identity lost');
const value=new WebAssembly.Instance(message.module).exports.add(19,23);port1.close();
console.log(JSON.stringify({value,exit}));`,
      '/child.mjs':`import {workerData} from 'node:worker_threads';
const input=new Uint8Array(${JSON.stringify(bytes)}),module=new WebAssembly.Module(input);
input.fill(255);workerData.postMessage({module,alias:module});workerData.close();`,
    },{experimentalFibers:true,timeoutMs:20000})
    try{return await kernel.runModule('/main.mjs',{guestWasm:true,webAPIs:true,timeoutMs:20000})}finally{kernel.close()}
  },addModule)
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({value:42,exit:0})
})
