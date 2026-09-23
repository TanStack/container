import {Worker,isMainThread,parentPort,threadId} from 'node:worker_threads'
import {fileURLToPath} from 'node:url'

const filename=fileURLToPath(new URL('./worker-threads-child.mjs',import.meta.url))
const results={main:{isMainThread,parentPort,threadId}}

async function roundTrip(early){
  const worker=new Worker(filename,{env:{...process.env,WORKER_FIXTURE:'copied'},workerData:{offset:7}})
  let online=false,ready=false,result,unrefReturnedUndefined=false
  const exited=new Promise((resolve,reject)=>{
    worker.on('online',()=>{online=true})
    worker.on('error',reject)
    worker.on('message',message=>{
      if(!online){reject(new Error('message arrived before online'));return}
      if(message.type==='ready'){
        ready=true
        if(!early)worker.postMessage({type:'args',module:message.module,payload:35})
      }
      if(message.type==='result'){
        result=message.payload
        // SvelteKit releases the worker reference after receiving its result.
        unrefReturnedUndefined=worker.unref()===undefined
      }
    })
    worker.on('exit',code=>resolve({code,online,ready,result,unrefReturnedUndefined,threadId:worker.threadId}))
  })
  // Keep this control alive so unref does not end the parent before exit delivery.
  const keepAlive=setInterval(()=>{},1000)
  try{
    if(early)worker.postMessage({type:'args',module:'early',payload:35})
    return await exited
  }finally{clearInterval(keepAlive)}
}
results.handshake=await roundTrip(false)
results.early=await roundTrip(true)
results.error=await new Promise((resolve,reject)=>{
  const worker=new Worker(filename,{workerData:{mode:'error'}}),events=[]
  worker.on('error',error=>events.push({type:'error',name:error.name,message:error.message}))
  worker.on('exit',code=>resolve({events,code}))
  worker.on('message',()=>reject(new Error('throwing worker unexpectedly sent a message')))
})
results.terminate=await new Promise((resolve,reject)=>{
  const worker=new Worker(filename,{workerData:{mode:'wait'}})
  let exitCode,exitCount=0
  worker.on('error',reject)
  worker.on('exit',code=>{exitCode=code;exitCount++})
  worker.once('message',async()=>{
    try{
      const refReturnedUndefined=worker.ref()===undefined
      const code=await worker.terminate()
      resolve({code,exitCode,exitCount,refReturnedUndefined,threadId:worker.threadId})
    }catch(error){reject(error)}
  })
})
results.largeMessage=await new Promise((resolve,reject)=>{
  const worker=new Worker(filename,{workerData:{mode:'large-message'}})
  worker.on('error',reject)
  worker.on('message',message=>resolve({received:message.received,reply:message.text.length}))
  worker.postMessage({text:'a'.repeat(256*1024)})
})
console.log(JSON.stringify(results))
