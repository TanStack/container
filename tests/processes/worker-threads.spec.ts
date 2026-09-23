import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'

const names=['worker-threads-parent.mjs','worker-threads-child.mjs']
const files=Object.fromEntries(names.map(name=>['/'+name,readFileSync('tests/fixtures/'+name,'utf8')]))

for(const guestWasm of [false,true])test(`worker threads: SvelteKit messaging and lifecycle ${guestWasm?'WASM':'default'}`,async({page},info)=>{
  const node=spawnSync(process.execPath,['tests/fixtures/worker-threads-parent.mjs'],{encoding:'utf8',timeout:15000})
  expect(node.status,node.stderr).toBe(0)
  const expected=JSON.parse(node.stdout)
  expect(expected.main).toEqual({isMainThread:true,parentPort:null,threadId:0})
  const roundTrip={code:0,online:true,ready:true,result:{value:42,env:'copied',workerData:{offset:7},isMainThread:false,positiveThreadId:true},unrefReturnedUndefined:true,threadId:-1}
  expect(expected.handshake).toEqual(roundTrip)
  expect(expected.early).toEqual(roundTrip)
  expect(expected.error).toEqual({events:[{type:'error',name:'Error',message:'worker fixture failure'}],code:1})
  expect(expected.terminate).toEqual({code:1,exitCode:1,exitCount:1,refReturnedUndefined:true,threadId:-1})
  expect(expected.largeMessage).toEqual({received:256*1024,reply:256*1024})
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({files,guestWasm})=>{
    const kernel=new window.sandboxLab.WorkerKernel(files,{maxBytes:128*1024*1024,workerMaxBytes:128*1024*1024})
    try{return await kernel.runModule('/worker-threads-parent.mjs',{guestWasm,webAPIs:true,timeoutMs:15000})}finally{kernel.close()}
  },{files,guestWasm})
  await info.attach('worker-threads.json',{body:JSON.stringify({node:expected,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(expected)
})

test('worker threads move 512 KiB Vite-style payloads through the WASM runtime',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const files={
      '/parent.mjs':`import {Worker} from 'node:worker_threads';const worker=new Worker('/child.mjs');const result=await new Promise((resolve,reject)=>{worker.on('error',reject);worker.on('message',message=>resolve({received:message.received,reply:message.text.length}));worker.postMessage({text:'a'.repeat(512*1024)})});console.log(JSON.stringify(result))`,
      '/child.mjs':`import {parentPort} from 'node:worker_threads';parentPort.once('message',message=>{parentPort.postMessage({received:message.text.length,text:'b'.repeat(512*1024)});parentPort.close()})`,
    }
    const kernel=new window.sandboxLab.WorkerKernel(files,{maxBytes:128*1024*1024,workerMaxBytes:128*1024*1024})
    try{return await kernel.runModule('/parent.mjs',{guestWasm:true,webAPIs:true,timeoutMs:15000})}finally{kernel.close()}
  })
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({received:512*1024,reply:512*1024})
})
