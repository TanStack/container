export const nativeWorkerEvalSource='const {parentPort,workerData}=require("node:worker_threads");parentPort.on("message",value=>{parentPort.postMessage({answer:workerData.base+value,filename:__filename,dirname:__dirname});parentPort.close()});'
export const nativeWorkerEvalParent=`const {Worker}=require('node:worker_threads');
let invalidCode;try{new Worker(new URL('file:///app/child.mjs'),{eval:true})}catch(error){invalidCode=error.code}
const worker=new Worker(${JSON.stringify(nativeWorkerEvalSource)},{eval:true,workerData:{base:40},stdout:true,stderr:true});
let message;worker.on('message',value=>message=value);
worker.stdout.resume();worker.stderr.resume();
worker.once('online',()=>worker.postMessage(2));
worker.once('exit',code=>{console.log(JSON.stringify({code,message,invalidCode}));if(code!==0)process.exitCode=1});
worker.once('error',error=>{console.error(error);process.exitCode=1});`
export const nativeWorkerEvalExpected={code:0,message:{answer:42,filename:'[worker eval]',dirname:'.'},invalidCode:'ERR_INVALID_ARG_VALUE'}
