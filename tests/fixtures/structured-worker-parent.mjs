import {Worker,MessageChannel} from 'node:worker_threads'
import {makePayload} from './structured-clone-values.mjs'
const payload=makePayload(),{port1,port2}=new MessageChannel()
const worker=new Worker(new URL('./structured-worker-child.mjs',import.meta.url))
const result=new Promise((resolve,reject)=>{worker.on('error',reject);port1.on('message',resolve)})
const completion=new Promise(resolve=>worker.on('exit',resolve))
worker.postMessage({payload,port:port2},[payload.buffer,port2])
const length=value=>{try{return value.byteLength}catch{return 0}}
const detached={buffer:length(payload.buffer),bytes:length(payload.bytes),words:length(payload.words),view:length(payload.view)}
console.log(JSON.stringify({summary:await result,detached,code:await completion}))
port1.close()
