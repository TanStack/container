import {Worker,workerData,parentPort,threadId,isMainThread} from 'node:worker_threads'
import {count,storage} from './nested-worker-state.mjs'
console.log('middle stdout')
const leaf=storage.run('middle-store',()=>new Worker(new URL('./nested-worker-leaf.mjs',import.meta.url),{
 workerData:{port:workerData.port,parentThreadId:threadId},transferList:[workerData.port],stdout:true,stderr:true,
}))
let stdout='',stderr=''
leaf.stdout.on('data',chunk=>{stdout+=chunk})
leaf.stderr.on('data',chunk=>{stderr+=chunk})
leaf.on('error',error=>{throw error})
leaf.on('exit',code=>{parentPort.postMessage({count,store:storage.getStore()??null,isMainThread,code,stdout,stderr});parentPort.close()})
