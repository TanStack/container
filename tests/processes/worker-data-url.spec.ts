import {test,expect} from '@playwright/test'
import {spawnSync} from 'node:child_process'

const source=`import {Worker} from 'node:worker_threads';
const rows=[];
for(const base64 of [false,true]){
  const code="import {parentPort,workerData} from 'node:worker_threads';parentPort.postMessage({value:workerData+1,text:'café 😀',url:import.meta.url,filename:typeof import.meta.filename});";
  const url=new URL('data:text/javascript'+(base64?';base64,':',')+(base64?Buffer.from(code).toString('base64'):encodeURIComponent(code)));
  rows.push(await new Promise((resolve,reject)=>{const worker=new Worker(url,{workerData:41,execArgv:[]});worker.once('message',resolve);worker.once('error',reject)}));
}
for(const url of ['data:text/plain,hello','data:text/javascript,import "./relative.mjs"']){
  rows.push(await new Promise(resolve=>{const worker=new Worker(new URL(url),{execArgv:[]});worker.once('error',error=>resolve({code:error.code}));worker.once('message',()=>resolve('unexpected message'))}));
}
console.log(JSON.stringify(rows));`

for(const guestWasm of [false,true])test(`data URL workers preserve source identity ${guestWasm?'WASM':'default'}`,async({page})=>{
  const native=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:15000})
  expect(native.status,native.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const guest=await page.evaluate(async({source,guestWasm})=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source})
    try{return await kernel.runModule('/main.mjs',{guestWasm,webAPIs:true,timeoutMs:15000})}finally{kernel.close()}
  },{source,guestWasm})
  expect(guest.exitCode,guest.stderr).toBe(0)
  expect(guest.stdout).toBe(native.stdout)
})
