import {test,expect} from '@playwright/test'

for(const guestWasm of [false,true])test(`shared storage budgets isolate kernels and include children, guestWasm=${guestWasm}`,async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async guestWasm=>{
    const files={
      '/main.mjs':`import {Worker} from 'node:worker_threads';
const shared=new SharedArrayBuffer(32768),view=new Int32Array(shared);view[0]=41;
const worker=new Worker(new URL('./child.mjs',import.meta.url),{workerData:shared});
const exit=new Promise((resolve,reject)=>{worker.once('exit',resolve);worker.once('error',reject)});
const reply=await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)});
console.log(JSON.stringify({reply,parentValue:view[0],exit:await exit}));`,
      '/child.mjs':`import {workerData,parentPort} from 'node:worker_threads';
let rejected=false;try{new SharedArrayBuffer(40000)}catch{rejected=true}
new Int32Array(workerData)[0]++;parentPort.postMessage({rejected,bytes:workerData.byteLength});parentPort.close();`,
    }
    const small=new window.sandboxLab.WorkerKernel(files,{experimentalFibers:true,sharedMemoryPerEngine:{maxBytes:65536},timeoutMs:20000})
    const larger=new window.sandboxLab.WorkerKernel({},{experimentalFibers:true,sharedMemoryPerEngine:{maxBytes:131072},timeoutMs:20000})
    try{
      const rejected=await small.execute(`let rejected=false;try{new SharedArrayBuffer(65537)}catch{rejected=true}console.log(JSON.stringify({rejected}))`,{guestWasm})
      const accepted=await larger.execute('console.log(new SharedArrayBuffer(65537).byteLength)',{guestWasm})
      const child=await small.runModule('/main.mjs',{guestWasm,webAPIs:true,timeoutMs:20000})
      const recovered=await small.execute('console.log(42)',{guestWasm})
      return {rejected,accepted,child,recovered}
    }finally{small.close();larger.close()}
  },guestWasm)
  await info.attach('shared-budget.json',{body:JSON.stringify(result),contentType:'application/json'})
  for(const entry of Object.values(result))expect(entry.exitCode,entry.stderr).toBe(0)
  expect(JSON.parse(result.rejected.stdout)).toEqual({rejected:true})
  expect(result.accepted.stdout).toBe('65537\n')
  expect(JSON.parse(result.child.stdout)).toEqual({reply:{rejected:true,bytes:32768},parentValue:42,exit:0})
  expect(result.recovered.stdout).toBe('42\n')
})

test('shared WASM growth respects the group budget and preserves old views',async({page},info)=>{
  await page.goto('/sandbox.html')
  const results=await page.evaluate(async()=>{
    const results=[]
    // The smaller budget cannot hold the resulting payload plus its header,
    // regardless of whether the allocator can grow in place.
    for(const maxBytes of [131072,262144]){
      const kernel=new window.sandboxLab.WorkerKernel({},{experimentalFibers:true,sharedMemoryPerEngine:{maxBytes},timeoutMs:20000})
      try{
        results.push(await kernel.execute(`
const memory=new WebAssembly.Memory({initial:1,maximum:65536,shared:true}),old=memory.buffer;
new Int32Array(old)[0]=42;
let rejected=false,previous=null;try{previous=memory.grow(1)}catch(error){rejected=error instanceof RangeError}
console.log(JSON.stringify({rejected,previous,length:memory.buffer.byteLength,same:memory.buffer===old,oldLength:old.byteLength,value:new Int32Array(memory.buffer)[0]}));
`,{guestWasm:true,webAPIs:true,timeoutMs:20000}))
      }finally{kernel.close()}
    }
    return results
  })
  await info.attach('shared-budget-growth.json',{body:JSON.stringify(results),contentType:'application/json'})
  for(const result of results)expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(results[0].stdout)).toEqual({rejected:true,previous:null,length:65536,same:true,oldLength:65536,value:42})
  expect(JSON.parse(results[1].stdout)).toEqual({rejected:false,previous:1,length:131072,same:false,oldLength:65536,value:42})
})

test('shared memory budget requires the explicit fiber engine option',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(()=>{
    let rejected=false,kernel
    try{kernel=new window.sandboxLab.WorkerKernel({},{sharedMemoryPerEngine:{maxBytes:65536}})}catch{rejected=true}finally{kernel?.close()}
    return rejected
  })
  expect(result).toBe(true)
})
