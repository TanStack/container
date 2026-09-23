import {Worker,MessageChannel} from 'node:worker_threads'
const output=[]
for(const mode of ['bootstrap','postMessage','started']){
 const {port1,port2}=new MessageChannel()
 port2.unref()
 // This queued message must follow the endpoint into its new runtime.
 port1.postMessage(35)
 const source=`const {workerData,parentPort}=require('node:worker_threads');
  function run(port){port.on('message',n=>{port.postMessage(n+7);port.close();parentPort.close()})}
  if(workerData)run(workerData.port);else parentPort.on('message',value=>run(value.port));`
 const worker=new Worker(source,{eval:true,execArgv:['--input-type=commonjs'],...(mode==='bootstrap'?{workerData:{port:port2},transferList:[port2]}:{})})
 const exited=new Promise((resolve,reject)=>{worker.on('error',reject);worker.on('exit',resolve)})
 const received=new Promise(resolve=>port1.once('message',resolve))
 if(mode==='started')port2.start()
 if(mode!=='bootstrap')worker.postMessage({port:port2},[port2])
 const value=await received;port1.close()
 output.push({mode,value,code:await exited})
}
console.log(JSON.stringify(output))
