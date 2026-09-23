import {parentPort,workerData} from 'node:worker_threads'
const {module,memory}=workerData
const api=new WebAssembly.Instance(module,{env:{memory}}).exports
const oldView=new Int32Array(memory.buffer)
parentPort.postMessage({type:'ready',old:api.add(0,3)})
parentPort.on('message',async message=>{
  if(message.type==='notify'){
    const deadline=Date.now()+3000
    let count=0
    while(count===0&&Date.now()<deadline){
      count=api.notify(4,1)
      if(!count)await new Promise(resolve=>setTimeout(resolve,1))
    }
    parentPort.postMessage({type:'notified',count})
  }else if(message.type==='grown'){
    api.add(0,1)
    parentPort.postMessage({type:'grown',oldLength:oldView.byteLength,newLength:memory.buffer.byteLength,value:api.load(65536)})
  }
})
