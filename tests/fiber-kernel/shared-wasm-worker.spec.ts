import {test,expect} from '@playwright/test'

test('WASM backing buffer remains live after its Memory creator exits',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({
      '/main.mjs':`import {Worker,MessageChannel,receiveMessageOnPort} from 'node:worker_threads';
const {port1,port2}=new MessageChannel();
const worker=new Worker(new URL('./child.mjs',import.meta.url),{workerData:port2,transferList:[port2]});
const code=await new Promise((resolve,reject)=>{worker.on('exit',resolve);worker.on('error',reject)});
const delivery=receiveMessageOnPort(port1);if(!delivery)throw Error('Missing queued buffer');
const buffer=delivery.message;
if(!(buffer instanceof SharedArrayBuffer))throw Error('Expected shared backing buffer');
const view=new Uint8Array(buffer),before=[view[0],view[view.length-1]];
view[0]=42;view[view.length-1]=84;
const alias=new Uint8Array(buffer);
port1.close();console.log(JSON.stringify({code,length:buffer.byteLength,before,after:[alias[0],alias[alias.length-1]]}));`,
      '/child.mjs':`import {workerData} from 'node:worker_threads';
const memory=new WebAssembly.Memory({initial:1,maximum:2,shared:true}),view=new Uint8Array(memory.buffer);
view[0]=41;view[view.length-1]=83;
workerData.postMessage(memory.buffer);workerData.close();`,
    },{experimentalFibers:true,timeoutMs:20000})
    try{return await kernel.runModule('/main.mjs',{guestWasm:true,webAPIs:true,timeoutMs:20000})}finally{kernel.close()}
  })
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({code:0,length:65536,before:[41,83],after:[42,84]})
})
import {readFileSync} from 'node:fs'

test('shared WASM memory worker data and round trips preserve control and graph identity',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({
      '/main.mjs':`import {Worker} from 'node:worker_threads';
const memory=new WebAssembly.Memory({initial:1,maximum:3,shared:true});
const old=memory.buffer;new Uint8Array(old)[0]=41;
const worker=new Worker(new URL('./child.mjs',import.meta.url),{workerData:{memory,alias:memory}});
const exit=new Promise((resolve,reject)=>{worker.on('exit',resolve);worker.on('error',reject)});
const next=()=>new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)});
const first=await next();
if(first.memory!==first.alias||!(first.memory instanceof WebAssembly.Memory))throw Error('Reply memory identity lost');
if(memory.buffer.byteLength!==131072||old.byteLength!==65536||new Uint8Array(old)[0]!==42)throw Error('Growth or old view changed incorrectly');
if(new Uint8Array(memory.buffer)[65536]!==73)throw Error('New page is not shared');
if(first.memory.grow(1)!==2||memory.buffer.byteLength!==196608)throw Error('Returned memory lost its control');
const response=next();worker.postMessage({memory,alias:memory});
const second=await response;
console.log(JSON.stringify({pages:memory.buffer.byteLength/65536,oldBytes:old.byteLength,oldValue:new Uint8Array(old)[0],reply:second,exit:await exit}));`,
      '/child.mjs':`import {workerData,parentPort} from 'node:worker_threads';
const {memory,alias}=workerData;
if(memory!==alias||!(memory instanceof WebAssembly.Memory))throw Error('Startup memory identity lost');
const old=memory.buffer;
if(memory.grow(1)!==1||old.byteLength!==65536)throw Error('Child growth failed');
new Uint8Array(old)[0]++;new Uint8Array(memory.buffer)[65536]=73;
parentPort.postMessage({memory,alias:memory});
parentPort.on('message',message=>{
 if(message.memory!==message.alias||message.memory.buffer.byteLength!==196608||memory.buffer.byteLength!==196608)throw Error('Round trip control lost');
 new Uint8Array(message.memory.buffer)[0]++;
 parentPort.postMessage('shared');parentPort.close();
});`,
    },{experimentalFibers:true,timeoutMs:20000})
    try{return await kernel.runModule('/main.mjs',{guestWasm:true,webAPIs:true,timeoutMs:20000})}finally{kernel.close()}
  })
  await info.attach('shared-wasm-worker.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({pages:3,oldBytes:65536,oldValue:43,reply:'shared',exit:0})
})

test('queued Memory survives its creator exiting before MessagePort adoption',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({
      '/main.mjs':`import {Worker,MessageChannel,receiveMessageOnPort} from 'node:worker_threads';
const {port1,port2}=new MessageChannel();
const worker=new Worker(new URL('./child.mjs',import.meta.url),{workerData:{port:port2},transferList:[port2]});
const code=await new Promise((resolve,reject)=>{worker.on('exit',resolve);worker.on('error',reject)});
const {message}=receiveMessageOnPort(port1);
if(message.memory!==message.alias||!(message.memory instanceof WebAssembly.Memory))throw Error('Queued memory identity lost');
const old=message.memory.buffer,before=new Uint8Array(old)[0];
const previous=message.memory.grow(1);new Uint8Array(message.memory.buffer)[65536]=82;
port1.close();
console.log(JSON.stringify({code,before,previous,oldBytes:old.byteLength,bytes:message.memory.buffer.byteLength,newValue:new Uint8Array(message.memory.buffer)[65536]}));`,
      '/child.mjs':`import {workerData} from 'node:worker_threads';
const memory=new WebAssembly.Memory({initial:1,maximum:2,shared:true});
new Uint8Array(memory.buffer)[0]=81;
workerData.port.postMessage({memory,alias:memory});workerData.port.close();`,
    },{experimentalFibers:true,timeoutMs:20000})
    try{return await kernel.runModule('/main.mjs',{guestWasm:true,webAPIs:true,timeoutMs:20000})}finally{kernel.close()}
  })
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({code:0,before:81,previous:1,oldBytes:65536,bytes:131072,newValue:82})
})

test('unshared Memory rejection leaves worker messaging usable',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({
      '/main.mjs':`import {Worker} from 'node:worker_threads';
const worker=new Worker(new URL('./child.mjs',import.meta.url));
const exit=new Promise((resolve,reject)=>{worker.on('exit',resolve);worker.on('error',reject)});
const reply=new Promise((resolve,reject)=>{worker.on('message',resolve);worker.on('error',reject)});
const shared=new WebAssembly.Memory({initial:1,maximum:2,shared:true});
let rejected=false;
try{worker.postMessage({shared,ordinary:new WebAssembly.Memory({initial:1,maximum:2})})}catch{rejected=true}
if(!rejected)throw Error('Unshared memory was silently cloned');
worker.postMessage({shared,answer:42});
console.log(JSON.stringify({rejected,reply:await reply,exit:await exit}));`,
      '/child.mjs':`import {parentPort} from 'node:worker_threads';
parentPort.on('message',message=>{
 if(!(message.shared instanceof WebAssembly.Memory)||message.answer!==42)throw Error('Unexpected delivery after rejected clone');
 parentPort.postMessage(message.answer);parentPort.close();
});`,
    },{experimentalFibers:true,timeoutMs:20000})
    try{return await kernel.runModule('/main.mjs',{guestWasm:true,webAPIs:true,timeoutMs:20000})}finally{kernel.close()}
  })
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({rejected:true,reply:42,exit:0})
})

test('worker WASM instances import the same memory and observe native growth',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async bytes=>{
    const kernel=new window.sandboxLab.WorkerKernel({
      '/main.mjs':`import {Worker} from 'node:worker_threads';
const bytes=${JSON.stringify(bytes)},memory=new WebAssembly.Memory({initial:1,maximum:2,shared:true});
const instance=new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(bytes)),{env:{memory}});
instance.exports.store(0,41);const old=memory.buffer;
const worker=new Worker(new URL('./child.mjs',import.meta.url),{workerData:{bytes,memory}});
const code=await new Promise((resolve,reject)=>{worker.on('exit',resolve);worker.on('error',reject)});
console.log(JSON.stringify({code,pages:instance.exports.size(),first:instance.exports.load(0),second:instance.exports.load(65536),oldBytes:old.byteLength}));`,
      '/child.mjs':`import {workerData} from 'node:worker_threads';
const {bytes,memory}=workerData;
const instance=new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(bytes)),{env:{memory}});
if(instance.exports.load(0)!==41||instance.exports.grow(1)!==1)throw Error('Shared WASM import failed');
instance.exports.store(0,42);instance.exports.store(65536,73);`,
    },{experimentalFibers:true,timeoutMs:20000})
    try{return await kernel.runModule('/main.mjs',{guestWasm:true,webAPIs:true,timeoutMs:20000})}finally{kernel.close()}
  },Array.from(readFileSync('fixtures/shared-wasm/memory.wasm')))
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({code:0,pages:2,first:42,second:73,oldBytes:65536})
})
