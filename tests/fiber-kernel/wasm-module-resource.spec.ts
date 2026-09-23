import {test,expect} from '@playwright/test'

const addModule=[0,97,115,109,1,0,0,0,1,7,1,96,2,127,127,1,127,3,2,1,0,7,7,1,3,97,100,100,0,0,10,9,1,7,0,32,0,32,1,106,11]
function paddedModuleBytes(base:number[]){
  const length=128*1024,prefix:number[]=[]
  let remaining=length
  do{const byte=remaining&127;remaining>>>=7;prefix.push(byte|(remaining?128:0))}while(remaining)
  const bytes=new Uint8Array(base.length+1+prefix.length+length)
  bytes.set(base);bytes[base.length]=0;bytes.set(prefix,base.length+1)
  // One-byte custom section name, followed by ordinary inert custom data.
  const offset=base.length+1+prefix.length
  bytes[offset]=1;bytes[offset+1]=120
  return bytes
}
const nativeBytes=paddedModuleBytes(addModule)
const createInput=`const input=(${paddedModuleBytes.toString()})(${JSON.stringify(addModule)}),module=new WebAssembly.Module(input);input.fill(255);`

test('large WASM resource clones through workerData and postMessage with aliases intact',async({page},info)=>{
  expect(nativeBytes.length).toBeGreaterThan(128*1024)
  const nativeAdd=new WebAssembly.Instance(new WebAssembly.Module(nativeBytes)).exports.add as (a:number,b:number)=>number
  expect(nativeAdd(20,22)).toBe(42)
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async createInput=>{
    const kernel=new window.sandboxLab.WorkerKernel({
      '/main.mjs':`import {Worker} from 'node:worker_threads';
${createInput}
const worker=new Worker(new URL('./child.mjs',import.meta.url),{workerData:{module,alias:module}});
const exit=new Promise((resolve,reject)=>{worker.on('exit',resolve);worker.on('error',reject)});
const next=()=>new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)});
const first=await next();
if(first.module!==first.alias||!(first.module instanceof WebAssembly.Module))throw Error('Startup reply aliases lost');
const replyValue=new WebAssembly.Instance(first.module).exports.add(21,21);
const pending=next();worker.postMessage({module,alias:module});
const originalAfterSend=new WebAssembly.Instance(module).exports.add(40,2);
const second=await pending;
if(second.module!==second.alias)throw Error('Roundtrip aliases lost');
const roundtripValue=new WebAssembly.Instance(second.module).exports.add(19,23);
console.log(JSON.stringify({startup:first.value,replyValue,originalAfterSend,second:second.value,roundtripValue,exit:await exit}));`,
      '/child.mjs':`import {parentPort,workerData} from 'node:worker_threads';
if(workerData.module!==workerData.alias||!(workerData.module instanceof WebAssembly.Module))throw Error('Worker data aliases lost');
parentPort.postMessage({module:workerData.module,alias:workerData.module,value:new WebAssembly.Instance(workerData.module).exports.add(20,22)});
parentPort.on('message',message=>{
 if(message.module!==message.alias||!(message.module instanceof WebAssembly.Module))throw Error('Worker message aliases lost');
 const value=new WebAssembly.Instance(message.module).exports.add(40,2);
 parentPort.postMessage({module:message.module,alias:message.module,value});
 if(new WebAssembly.Instance(message.module).exports.add(21,21)!==42)throw Error('Sender module became unusable');
 parentPort.close();
});`,
    },{experimentalFibers:true,timeoutMs:20000})
    try{return await kernel.runModule('/main.mjs',{guestWasm:true,webAPIs:true,timeoutMs:20000})}finally{kernel.close()}
  },createInput)
  await info.attach('large-wasm-worker-resource.json',{body:JSON.stringify({byteLength:nativeBytes.length,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({startup:42,replyValue:42,originalAfterSend:42,second:42,roundtripValue:42,exit:0})
})

test('large WASM resource queued on MessagePort survives creator exit',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async createInput=>{
    const kernel=new window.sandboxLab.WorkerKernel({
      '/main.mjs':`import {Worker,MessageChannel,receiveMessageOnPort} from 'node:worker_threads';
const {port1,port2}=new MessageChannel();
const worker=new Worker(new URL('./child.mjs',import.meta.url),{workerData:port2,transferList:[port2]});
const exit=await new Promise((resolve,reject)=>{worker.on('exit',resolve);worker.on('error',reject)});
const received=receiveMessageOnPort(port1);
if(!received)throw Error('Queued message missing');
const message=received.message;
if(message.module!==message.alias||!(message.module instanceof WebAssembly.Module))throw Error('Port aliases lost');
const value=new WebAssembly.Instance(message.module).exports.add(20,22);port1.close();
console.log(JSON.stringify({value,exit}));`,
      '/child.mjs':`import {workerData} from 'node:worker_threads';
${createInput}
workerData.postMessage({module,alias:module});
if(new WebAssembly.Instance(module).exports.add(40,2)!==42)throw Error('Port sender module became unusable');
workerData.close();`,
    },{experimentalFibers:true,timeoutMs:20000})
    try{return await kernel.runModule('/main.mjs',{guestWasm:true,webAPIs:true,timeoutMs:20000})}finally{kernel.close()}
  },createInput)
  await info.attach('large-wasm-port-resource.json',{body:JSON.stringify({byteLength:nativeBytes.length,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({value:42,exit:0})
})
