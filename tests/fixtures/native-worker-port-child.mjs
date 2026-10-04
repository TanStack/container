import {parentPort,workerData,MessageChannel} from 'node:worker_threads'
if(process.cwd()!==workerData.expectedCwd)throw Error('Worker inherited wrong cwd')
let changeRejected=false
try{process.chdir(process.cwd())}catch(error){changeRejected=error.code==='ERR_WORKER_UNSUPPORTED_OPERATION'}
if(!changeRejected)throw Error('Worker chdir was accepted')
if(workerData.self!==workerData||workerData.port!==workerData.again)
  throw Error('Worker data identity changed')
workerData.port.once('message',value=>{
  workerData.port.postMessage(value+3)
  workerData.port.close()
  const channel=new MessageChannel()
  channel.port2.once('message',value=>{
    if(process.cwd()!==value.cwd)throw Error('Worker did not observe parent cwd change')
    channel.port2.postMessage(value.value+1)
    channel.port2.close()
    parentPort.close()
  })
  parentPort.postMessage({port:channel.port1},[channel.port1])
})
