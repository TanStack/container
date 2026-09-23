import {Worker,MessageChannel} from 'node:worker_threads'
import {count,storage} from './nested-worker-state.mjs'
const {port1,port2}=new MessageChannel()
const leafResult=new Promise(resolve=>port1.once('message',resolve))
const middle=storage.run('owner-store',()=>new Worker(new URL('./nested-worker-middle.mjs',import.meta.url),{workerData:{port:port2},transferList:[port2],stdout:true}))
let stdout='',message
middle.stdout.on('data',chunk=>{stdout+=chunk})
middle.on('message',value=>{message=value})
const exited=new Promise((resolve,reject)=>{middle.on('error',reject);middle.on('exit',resolve)})
const leaf=await leafResult;port1.close();const code=await exited
console.log(JSON.stringify({count,store:storage.getStore()??null,code,stdout,middle:message,leaf}))
