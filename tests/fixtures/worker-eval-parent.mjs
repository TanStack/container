import {Worker} from 'node:worker_threads'
const output={}
for(const mode of ['commonjs','module']){
 const imports=mode==='commonjs'?`const {parentPort,workerData,isMainThread}=require('node:worker_threads');`:`import {parentPort,workerData,isMainThread} from 'node:worker_threads';`
 const source=imports+`parentPort.on('message',value=>{parentPort.postMessage({answer:value+workerData.offset,isMainThread,requireType:typeof require,execArgv:process.execArgv,args:process.argv.slice(-1)});parentPort.close()});`
 output[mode]=await new Promise((resolve,reject)=>{
  const worker=new Worker(source,{eval:true,execArgv:['--input-type='+mode],argv:['fixture-arg'],workerData:{offset:7}})
  let message,online=false
  worker.on('online',()=>{online=true;worker.postMessage(35)})
  worker.on('message',value=>{message=value})
  worker.on('error',reject)
  worker.on('exit',code=>resolve({online,code,message}))
 })
}
for(const [name,source,mode] of [['throw','throw new Error("eval fixture failure")','commonjs'],['invalid-commonjs','import "node:fs"','commonjs']]){
 output[name]=await new Promise((resolve,reject)=>{
  const worker=new Worker(source,{eval:true,execArgv:['--input-type='+mode]})
  let error
  worker.on('error',value=>{error={name:value.name,...(name==='throw'?{message:value.message}:{})}})
  worker.on('exit',code=>error?resolve({code,error}):reject(Error('Expected eval failure')))
 })
}
console.log(JSON.stringify(output))
