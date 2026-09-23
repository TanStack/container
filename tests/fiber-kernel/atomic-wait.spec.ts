import {test,expect} from '@playwright/test'

test('native atomic wait parks parent while child stores and notifies',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({
      '/main.mjs':`import {Worker} from 'node:worker_threads';
const buffer=new SharedArrayBuffer(16),view=new Int32Array(buffer);
const worker=new Worker(new URL('./child.mjs',import.meta.url),{workerData:buffer});
const exit=new Promise((resolve,reject)=>{worker.on('exit',resolve);worker.on('error',reject)});
const message=new Promise(resolve=>worker.on('message',resolve));
const mismatch=Atomics.wait(view,0,1,1000),zero=Atomics.wait(view,0,0,0);
const waited=Atomics.wait(view,0,0,5000);
const timed=Atomics.wait(view,1,0,5);
console.log(JSON.stringify({mismatch,zero,waited,timed,value:view[0],notified:await message,exit:await exit}));`,
      '/child.mjs':`import {workerData,parentPort} from 'node:worker_threads';
const view=new Int32Array(workerData);Atomics.store(view,0,42);parentPort.postMessage(Atomics.notify(view,0,1));`,
    },{experimentalFibers:true,timeoutMs:15000})
    try{return await kernel.runModule('/main.mjs',{webAPIs:true,timeoutMs:15000})}finally{kernel.close()}
  })
  await info.attach('atomic-worker.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({mismatch:'not-equal',zero:'timed-out',waited:'ok',timed:'timed-out',value:42,notified:1,exit:0})
})

test('cancelling a native atomic wait leaves the experimental engine usable',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/wait.mjs':`console.log('waiting');Atomics.wait(new Int32Array(new SharedArrayBuffer(16)),0,0);`},{experimentalFibers:true,timeoutMs:10000})
    try{
      const task=await kernel.spawn('node',['/wait.mjs'],{timeoutMs:10000})
      const ready=await task.next();await task.kill('SIGKILL');const stopped=await task.wait();await task.dispose()
      const recovered=await kernel.execute('console.log(42)')
      return {ready,stopped,recovered,resources:await kernel.resources()}
    }finally{kernel.close()}
  })
  expect(result.ready?.type).toBe('stdout');expect(result.stopped.signal).toBe('SIGKILL')
  expect(result.recovered.exitCode,result.recovered.stderr).toBe(0);expect(result.recovered.stdout).toBe('42\n')
  expect(result.resources.processes).toEqual({active:0,retained:0})
})
