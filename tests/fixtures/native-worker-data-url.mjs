const nested='data:text/javascript,'+encodeURIComponent('export let count=0;export function increment(){count++}')
const byteURLs=['%22%FF%22','%22%oops%22','%22%E2%82%22','%22caf%C3%A9%22'].map(payload=>'data:text/javascript,export default '+payload)
const source=`import {parentPort,workerData} from "node:worker_threads";
import {count,increment} from ${JSON.stringify(nested)};
await Promise.resolve();increment();
const first=await import(${JSON.stringify(nested)}),second=await import(${JSON.stringify(nested)});
let relativeError;try{await import('./relative.mjs')}catch(error){relativeError=error.code}
const decoded=[];for(const url of ${JSON.stringify(byteURLs)})decoded.push((await import(url)).default);
parentPort.postMessage({answer:workerData.base+2,url:import.meta.url,count,same:first===second,relativeError,decoded});parentPort.close();`
export const nativeWorkerDataURL='data:text/javascript,'+encodeURIComponent(source)
const base64URL='data:application/javascript;base64,'+Buffer.from(source).toString('base64')+'#base64'
export const nativeWorkerDataParent=`const {Worker}=require('node:worker_threads');
const run=url=>new Promise((resolve,reject)=>{
const worker=new Worker(new URL(url),{workerData:{base:40},stdout:true,stderr:true});
let message;worker.on('message',value=>message=value);worker.stdout.resume();worker.stderr.pipe(process.stderr);
worker.on('error',reject);worker.on('exit',code=>code?reject(Error('exit '+code)):resolve({code,message}));
});
(async()=>{const results=[];for(const url of ${JSON.stringify([nativeWorkerDataURL,base64URL])})results.push(await run(url));console.log(JSON.stringify(results))})().catch(error=>{console.error(error);process.exitCode=1});`
export const nativeWorkerDataExpected=[nativeWorkerDataURL,base64URL].map(url=>({code:0,message:{answer:42,url,count:1,same:true,relativeError:'ERR_UNSUPPORTED_RESOLVE_REQUEST',decoded:['\uFFFD','%oops','\uFFFD','café']}}))
