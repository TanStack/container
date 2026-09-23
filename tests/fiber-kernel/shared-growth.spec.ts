import {test,expect} from '@playwright/test'
import {spawnSync} from 'node:child_process'

const leb=(value:number)=>{const bytes=[];do{const byte=value&127;value>>>=7;bytes.push(byte|(value?128:0))}while(value);return bytes}
const text=(value:string)=>{const bytes=[...new TextEncoder().encode(value)];return [...leb(bytes.length),...bytes]}
const section=(id:number,payload:number[])=>[id,...leb(payload.length),...payload]
const body=(bytes:number[])=>[...leb(bytes.length),...bytes]
const wasm=[0,97,115,109,1,0,0,0,
  ...section(1,[2,96,1,127,1,127,96,2,127,127,0]),
  ...section(2,[1,...text('env'),...text('memory'),2,3,1,...leb(65536)]),
  ...section(3,[3,0,1,0]),
  ...section(7,[4,...text('memory'),2,0,...text('load'),0,0,...text('store'),0,1,...text('grow'),0,2]),
  ...section(10,[3,...body([0,32,0,40,2,0,11]),...body([0,32,0,32,1,54,2,0,11]),...body([0,32,0,64,0,11])]),
]

function growthEdges(bytes:number[]){
  const empty=new WebAssembly.Memory({initial:0,maximum:1,shared:true})
  const retained=empty.buffer,retainedView=new Uint8Array(retained)
  const emptyPrevious=empty.grow(1)
  const emptyZero=new Uint8Array(empty.buffer).every(value=>value===0)
  const memory=new WebAssembly.Memory({initial:1,maximum:4,shared:true})
  const module=new WebAssembly.Module(new Uint8Array(bytes))
  const a=new WebAssembly.Instance(module,{env:{memory}}).exports as any
  const b=new WebAssembly.Instance(module,{env:{memory}}).exports as any
  a.store(0,41)
  const first=b.grow(1)
  a.store(65536,73)
  const readByB=b.load(65536),second=a.grow(1)
  b.store(131072,99)
  return {emptyPrevious,emptyZero,retainedLength:retained.byteLength,retainedViewLength:retainedView.length,newLength:empty.buffer.byteLength,
    first,second,readByB,readByA:a.load(131072),original:b.load(0),sharedLength:memory.buffer.byteLength}
}

for(const growthReservation of [false,true])test(`zero-page growth and two instances preserve shared memory semantics: reservation=${growthReservation}`,async({page},info)=>{
  const expected=growthEdges(wasm)
  expect(expected).toEqual({emptyPrevious:0,emptyZero:true,retainedLength:0,retainedViewLength:0,newLength:65536,
    first:1,second:2,readByB:73,readByA:99,original:41,sharedLength:196608})
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({source,wasm,growthReservation})=>{
    const kernel=new window.sandboxLab.WorkerKernel({},{experimentalFibers:true,sharedMemoryPerEngine:{growthReservation},timeoutMs:20000})
    try{return await kernel.execute(`console.log(JSON.stringify((${source})(${JSON.stringify(wasm)})))`,{guestWasm:true,webAPIs:true,timeoutMs:20000})}finally{kernel.close()}
  },{source:growthEdges.toString(),wasm,growthReservation})
  await info.attach('shared-growth-edges.json',{body:JSON.stringify({expected,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(expected)
})

function viewGrowth(bytes:number[]){
  const memory=new WebAssembly.Memory({initial:1,maximum:65536,shared:true})
  const instance=new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(bytes)),{env:{memory}})
  const exports=instance.exports as unknown as {store(address:number,value:number):void;load(address:number):number;grow(pages:number):number}
  const original=memory.buffer,words=new Int32Array(original),subarray=words.subarray(1,3),data=new DataView(original,4,8)
  exports.store(0,41);subarray[0]=71
  const first=memory.grow(1),second=exports.grow(1),third=memory.grow(1)
  const current=new Int32Array(memory.buffer)
  const zero=new Uint8Array(memory.buffer,65536).every(value=>value===0)
  exports.store(4,72);data.setInt32(4,83,true);words[0]++
  return {first,second,third,zero,oldLength:original.byteLength,newLength:memory.buffer.byteLength,subarrayLength:subarray.length,dataLength:data.byteLength,old:[words[0],subarray[0],subarray[1]],current:[current[0],current[1],current[2]],wasm:[exports.load(0),exports.load(4),exports.load(8)]}
}

test('shared memory grows on demand while old typed arrays and DataViews remain live',async({page},info)=>{
  const expected=viewGrowth(wasm)
  expect(expected).toEqual({first:1,second:2,third:3,zero:true,oldLength:65536,newLength:262144,subarrayLength:2,dataLength:8,old:[42,72,83],current:[42,72,83],wasm:[42,72,83]})
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({source,wasm})=>{
    const kernel=new window.sandboxLab.WorkerKernel({},{experimentalFibers:true,timeoutMs:20000})
    try{return await kernel.execute(`console.log(JSON.stringify((${source})(${JSON.stringify(wasm)})))`,{guestWasm:true,webAPIs:true,timeoutMs:20000})}finally{kernel.close()}
  },{source:viewGrowth.toString(),wasm})
  await info.attach('shared-growth-views.json',{body:JSON.stringify({expected,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0);expect(JSON.parse(result.stdout)).toEqual(expected)
})

test('group budget growth rejection preserves memory and existing buffer identities',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async wasm=>{
    const kernel=new window.sandboxLab.WorkerKernel({},{experimentalFibers:true,timeoutMs:20000})
    try{return await kernel.execute(`
const memory=new WebAssembly.Memory({initial:1,maximum:65536,shared:true});
const instance=new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(${JSON.stringify(wasm)})),{env:{memory}});
const buffer=memory.buffer,view=new Int32Array(buffer);view[0]=42;
let rejected=false;try{memory.grow(272)}catch(error){rejected=error instanceof RangeError}
const wasmResult=instance.exports.grow(272);
console.log(JSON.stringify({rejected,wasmResult,same:memory.buffer===buffer,length:buffer.byteLength,value:view[0],wasmValue:instance.exports.load(0)}));
`,{guestWasm:true,webAPIs:true,timeoutMs:20000})}finally{kernel.close()}
  },wasm)
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({rejected:true,wasmResult:-1,same:true,length:65536,value:42,wasmValue:42})
})

test('growth beyond the group budget rolls back and permits later small growth',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({},{experimentalFibers:true,timeoutMs:20000})
    try{return await kernel.execute(`
const memory=new WebAssembly.Memory({initial:96,maximum:512,shared:true});
const old=memory.buffer;new Uint8Array(old)[0]=73;
let rejected=false;try{memory.grow(161)}catch(error){rejected=error instanceof RangeError}
const unchanged=memory.buffer===old&&new Uint8Array(old)[0]===73;
const previous=memory.grow(1);
console.log(JSON.stringify({rejected,unchanged,previous,bytes:memory.buffer.byteLength,oldBytes:old.byteLength,value:new Uint8Array(memory.buffer)[0]}));
`,{guestWasm:true,webAPIs:true,timeoutMs:20000})}finally{kernel.close()}
  })
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({rejected:true,unchanged:true,previous:96,bytes:97*65536,oldBytes:96*65536,value:73})
})

const queuedChild=`const {workerData,parentPort}=require('node:worker_threads');
const memory=new WebAssembly.Memory({initial:1,maximum:65536,shared:true});new Int32Array(memory.buffer)[0]=41;
workerData.postMessage(memory.buffer);parentPort.postMessage(memory);workerData.close();parentPort.close();`
const queuedSource=`import {Worker,MessageChannel,receiveMessageOnPort} from 'node:worker_threads';
const {port1,port2}=new MessageChannel();
const worker=new Worker(${JSON.stringify(queuedChild)},{eval:true,execArgv:['--input-type=commonjs'],workerData:port2,transferList:[port2]});
const exit=new Promise((resolve,reject)=>{worker.once('exit',resolve);worker.once('error',reject)});
const memory=await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)});
const code=await exit;const previous=memory.grow(1);
new Int32Array(memory.buffer)[0]=42;
const {message:old}=receiveMessageOnPort(port1),view=new Int32Array(old);const before=view[0];view[0]++;
port1.close();console.log(JSON.stringify({code,previous,oldLength:old.byteLength,newLength:memory.buffer.byteLength,before,after:new Int32Array(memory.buffer)[0]}));`
const waitChild=`const {workerData,parentPort}=require('node:worker_threads');const old=workerData.buffer,view=new Int32Array(old);parentPort.postMessage('ready');
const waited=Atomics.wait(view,0,0,5000);parentPort.postMessage({waited,value:view[1],oldLength:old.byteLength,newLength:workerData.buffer.byteLength});parentPort.close();`
const waitSource=`import {Worker} from 'node:worker_threads';
const memory=new WebAssembly.Memory({initial:1,maximum:65536,shared:true});
const worker=new Worker(${JSON.stringify(waitChild)},{eval:true,execArgv:['--input-type=commonjs'],workerData:memory});
const exit=new Promise((resolve,reject)=>{worker.once('exit',resolve);worker.once('error',reject)});
await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)});
const reply=new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)});
memory.grow(1);const view=new Int32Array(memory.buffer);Atomics.store(view,1,42);
let notified=0;const deadline=Date.now()+5000;
while(!notified&&Date.now()<deadline){notified=Atomics.notify(view,0,1);if(!notified)await new Promise(resolve=>setTimeout(resolve,1))}
console.log(JSON.stringify({reply:await reply,notified,exit:await exit}));`

for(const growthReservation of [false,true])for(const [name,source,expected] of [
  ['queued SAB survives creator exit and retained Memory growth',queuedSource,{code:0,previous:1,oldLength:131072,newLength:131072,before:42,after:43}],
  ['parked worker is notified through a grown Memory view',waitSource,{reply:{waited:'ok',value:42,oldLength:65536,newLength:131072},notified:1,exit:0}],
] as const)test(`${name}: reservation=${growthReservation}`,async({page},info)=>{
  const native=spawnSync(process.execPath,['--input-type=module'],{input:source,encoding:'utf8',timeout:15000})
  expect(native.status,native.stderr||native.error?.message).toBe(0)
  const reference=JSON.parse(native.stdout);expect(reference).toEqual(expected)
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({source,growthReservation})=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source},{experimentalFibers:true,sharedMemoryPerEngine:{growthReservation},timeoutMs:20000})
    try{return await kernel.runModule('/main.mjs',{guestWasm:true,webAPIs:true,timeoutMs:20000})}finally{kernel.close()}
  },{source,growthReservation})
  await info.attach('shared-growth-worker.json',{body:JSON.stringify({reference,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0);expect(JSON.parse(result.stdout)).toEqual(reference)
})
