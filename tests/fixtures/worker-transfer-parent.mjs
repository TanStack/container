import {Worker} from 'node:worker_threads'
const bootstrap=new Uint8Array([7,8,9]),alias=new Uint8Array(bootstrap.buffer)
const worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads');
 parentPort.on('message',value=>{
  const result={bootstrap:Array.from(workerData.bytes),bytes:Array.from(value.view),alias:value.view.buffer===value.buffer};
  parentPort.postMessage(result);parentPort.close();
 });`,{eval:true,execArgv:['--input-type=commonjs'],workerData:{bytes:bootstrap},transferList:[bootstrap.buffer]})
const result=await new Promise((resolve,reject)=>{
 let message
 worker.on('error',reject);worker.on('message',value=>{message=value})
 const bytes=new Uint8Array([40,41,42]),view=bytes.subarray(1)
 worker.postMessage({view,buffer:bytes.buffer},[bytes.buffer])
 const detached={bootstrap:bootstrap.byteLength,alias:alias.byteLength,input:bytes.byteLength,view:view.byteLength}
 worker.on('exit',code=>resolve({message,detached,code}))
})
console.log(JSON.stringify(result))
