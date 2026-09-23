import {isMainThread,parentPort,threadId,workerData} from 'node:worker_threads'

if(workerData?.mode==='error')throw new Error('worker fixture failure')
if(workerData?.mode==='large-message'){
  parentPort.once('message',message=>{
    parentPort.postMessage({received:message.text.length,text:'b'.repeat(256*1024)})
    parentPort.close()
  })
}else
if(workerData?.mode==='wait'){
  parentPort.on('message',()=>{})
  parentPort.postMessage({type:'ready'})
}else{
  parentPort.on('message',message=>{
    if(message.type!=='args')return
    parentPort.postMessage({
      type:'result',module:message.module,
      payload:{value:message.payload+workerData.offset,env:process.env.WORKER_FIXTURE,
        workerData,isMainThread,positiveThreadId:threadId>0},
    })
    parentPort.close()
  })
  parentPort.postMessage({type:'ready',module:import.meta.url})
}
