import {test,expect} from '@playwright/test'

// Real preview1 imports with exported wrappers, so a wait suspends inside WASM.
const leb=(value:number)=>{const bytes=[];do{const byte=value&127;value>>>=7;bytes.push(byte|(value?128:0))}while(value);return bytes}
const text=(value:string)=>{const bytes=[...new TextEncoder().encode(value)];return [...leb(bytes.length),...bytes]}
const section=(id:number,bytes:number[])=>[id,...leb(bytes.length),...bytes]
const body=(bytes:number[])=>[...leb(bytes.length),...bytes]
const fixture=[0,97,115,109,1,0,0,0,
  ...section(1,[2,0x60,4,0x7f,0x7f,0x7f,0x7f,1,0x7f,0x60,0,1,0x7f]),
  ...section(2,[2,...text('wasi_snapshot_preview1'),...text('poll_oneoff'),0,0,...text('wasi_snapshot_preview1'),...text('sched_yield'),0,1]),
  ...section(3,[2,0,1]),...section(5,[1,0,1]),
  ...section(7,[3,...text('memory'),2,0,...text('poll'),0,2,...text('yield'),0,3]),
  ...section(10,[2,...body([0,0x20,0,0x20,1,0x20,2,0x20,3,0x10,0,0x0b]),...body([0,0x10,1,0x0b])]),
]

for(const mode of ['zero','clock','yield'] as const)test(`WASI ${mode} import completes with scheduler progress`,async({page},info)=>{
  expect(WebAssembly.validate(new Uint8Array(fixture))).toBe(true)
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({fixture,mode})=>{
    const kernel=new window.sandboxLab.WorkerKernel({
      '/main.mjs':`import {WASI} from 'node:wasi';import {Worker} from 'node:worker_threads';
const wasi=new WASI({version:'preview1',returnOnExit:true});
const instance=new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(${JSON.stringify(fixture)})),wasi.getImportObject());
wasi.initialize(instance);
const view=new DataView(instance.exports.memory.buffer);
view.setBigUint64(64,42n,true);view.setUint8(72,0);view.setUint32(80,1,true);
view.setBigUint64(88,${mode==='clock'?'5000000n':'0n'},true);view.setBigUint64(96,0n,true);view.setUint16(104,0,true);
let worker,exit,shared;
${mode==='zero'?'':`shared=new Int32Array(new SharedArrayBuffer(4));
worker=new Worker(new URL('./child.mjs',import.meta.url),{workerData:shared.buffer});
exit=new Promise((resolve,reject)=>{worker.on('exit',resolve);worker.on('error',reject)});
await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)});
Atomics.store(shared,0,1);Atomics.notify(shared,0,1);`}
const started=performance.now();
const errno=${mode==='yield'?'instance.exports.yield()':'instance.exports.poll(64,128,1,192)'};
const elapsed=performance.now()-started;
const progress=shared?Atomics.load(shared,0):null;
const record={errno,elapsed,progress,exit:exit?await exit:null};
${mode==='yield'?'':`record.count=view.getUint32(192,true);record.userdata=Number(view.getBigUint64(128,true));record.eventError=view.getUint16(136,true);record.type=view.getUint8(138);`}
console.log(JSON.stringify(record));`,
      '/child.mjs':`import {workerData,parentPort} from 'node:worker_threads';
const view=new Int32Array(workerData);parentPort.postMessage('ready');
Atomics.wait(view,0,0);Atomics.store(view,0,2);parentPort.close();`,
    },{experimentalFibers:true,timeoutMs:20000})
    try{return await kernel.runModule('/main.mjs',{guestWasm:true,webAPIs:true,timeoutMs:20000})}finally{kernel.close()}
  },{fixture,mode})
  await info.attach(`wasi-${mode}.json`,{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  const record=JSON.parse(result.stdout)
  expect(record.errno).toBe(0)
  if(mode!=='yield')expect(record).toMatchObject({count:1,userdata:42,eventError:0,type:0})
  if(mode!=='zero')expect(record).toMatchObject({progress:2,exit:0})
  if(mode==='clock')expect(record.elapsed).toBeGreaterThanOrEqual(5)
})
