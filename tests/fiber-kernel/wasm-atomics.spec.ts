import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'

const bytes=Array.from(readFileSync('fixtures/shared-wasm/atomic-coverage.wasm'))

for(const mode of ['wasm32-wasm','wasm64-js','js-wasm'] as const){
  test(`${mode} parks the parent while a child updates shared WASM memory`,async({page},info)=>{
    await page.goto('/sandbox.html')
    const result=await page.evaluate(async({bytes,mode})=>{
      const wait=mode==='wasm64-js'?'wasm.wait64(0,0n,5000000000n)':mode==='js-wasm'?"Atomics.wait(new Int32Array(memory.buffer),0,0,5000)":'wasm.wait32(0,0,5000000000n)'
      const update=mode==='wasm64-js'?'const view=new BigInt64Array(memory.buffer);Atomics.store(view,0,42n);const notified=Atomics.notify(view,0,1);':'wasm.i32_32_store(0,42);const notified=wasm.notify(0,1);'
      const kernel=new window.sandboxLab.WorkerKernel({
        '/main.mjs':`import {Worker} from 'node:worker_threads';
const bytes=${JSON.stringify(bytes)},memory=new WebAssembly.Memory({initial:1,maximum:2,shared:true});
const wasm=new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(bytes)),{env:{memory}}).exports;
const worker=new Worker(new URL('./child.mjs',import.meta.url),{workerData:{bytes,memory}});
const exit=new Promise((resolve,reject)=>{worker.once('exit',resolve);worker.once('error',reject)});
const next=()=>new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)});
if(await next()!=='ready')throw Error('Child did not initialize');
const message=next();worker.postMessage('go');
const waited=${wait};
console.log(JSON.stringify({waited,value:String(${mode==='wasm64-js'?'wasm.i64_64_load(0)':'wasm.i32_32_load(0)'}),notified:await message,exit:await exit}));`,
        '/child.mjs':`import {workerData,parentPort} from 'node:worker_threads';
const {bytes,memory}=workerData;
const wasm=new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(bytes)),{env:{memory}}).exports;
parentPort.once('message',message=>{
 if(message!=='go')throw Error('Unexpected child command');
 ${update}
 parentPort.postMessage(notified);parentPort.close();
});
parentPort.postMessage('ready');`,
      },{experimentalFibers:true,timeoutMs:20000})
      try{return await kernel.runModule('/main.mjs',{guestWasm:true,webAPIs:true,timeoutMs:20000})}finally{kernel.close()}
    },{bytes,mode})
    await info.attach('wasm-atomic-worker.json',{body:JSON.stringify(result),contentType:'application/json'})
    expect(result.exitCode,result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({waited:mode==='js-wasm'?'ok':0,value:'42',notified:1,exit:0})
  })
}

test('WASM wait mismatch, zero and finite timeouts preserve the running kernel',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async bytes=>{
    const kernel=new window.sandboxLab.WorkerKernel({
      '/main.mjs':`const memory=new WebAssembly.Memory({initial:1,maximum:2,shared:true});
const wasm=new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(${JSON.stringify(bytes)})),{env:{memory}}).exports;
const values=[wasm.wait32(0,1,5000000n),wasm.wait32(0,0,0n),wasm.wait32(0,0,5000000n),wasm.wait64(8,1n,5000000n),wasm.wait64(8,0n,0n),wasm.wait64(8,0n,5000000n)];
wasm.i32_32_store(0,42);console.log(JSON.stringify({values,value:wasm.i32_32_load(0)}));`,
    },{experimentalFibers:true,timeoutMs:20000})
    try{return await kernel.runModule('/main.mjs',{guestWasm:true,webAPIs:true,timeoutMs:20000})}finally{kernel.close()}
  },bytes)
  await info.attach('wasm-atomic-timeouts.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({values:[1,2,2,1,2,2],value:42})
})
