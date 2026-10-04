import {test} from 'node:test'
import assert from 'node:assert/strict'
import {Worker} from 'node:worker_threads'

test('Node ignores postMessage after worker exit without cloning or transferring',async()=>{
  const worker=new Worker('',{eval:true})
  await new Promise((resolve,reject)=>{worker.once('exit',resolve);worker.once('error',reject)})
  const bytes=new Uint8Array([1,2])
  assert.equal(worker.postMessage({bytes},[bytes.buffer]),undefined)
  assert.deepEqual([...bytes],[1,2])
  assert.equal(worker.postMessage(()=>{}),undefined)
})

test('Node shares running worker termination results and returns undefined after exit',async()=>{
  const worker=new Worker('setInterval(()=>{},1000)',{eval:true})
  const exits=[]
  worker.on('exit',code=>exits.push(code))
  await new Promise((resolve,reject)=>{worker.once('online',resolve);worker.once('error',reject)})
  const first=worker.terminate(),second=worker.terminate()
  assert.deepEqual(exits,[])
  assert.deepEqual(await Promise.all([first,second]),[1,1])
  assert.deepEqual(exits,[1])
  assert.equal(await worker.terminate(),undefined)
})

test('Node termination before startup reports zero and later returns undefined',async()=>{
  const worker=new Worker('setInterval(()=>{},1000)',{eval:true})
  assert.equal(await worker.terminate(),0)
  assert.equal(await worker.terminate(),undefined)
})

test('Node drains promise callbacks before deciding a worker has no referenced work',async()=>{
  const worker=new Worker(`const {parentPort}=require('node:worker_threads');
    setTimeout(()=>Promise.resolve().then(()=>Promise.resolve()).then(()=>{
      setTimeout(()=>parentPort.postMessage('finished'),15);
    }),5);`,{eval:true})
  const messages=[]
  worker.on('message',value=>messages.push(value))
  try{
    const code=await new Promise((resolve,reject)=>{worker.once('exit',resolve);worker.once('error',reject)})
    assert.equal(code,0);assert.deepEqual(messages,['finished'])
  }finally{await worker.terminate()}
})

test('Node workers finish naturally after referenced timers and parent port listeners release',async()=>{
  const worker=new Worker(`const {parentPort}=require('node:worker_threads');
    parentPort.once('message',()=>setTimeout(()=>parentPort.postMessage('finished'),10));`,{eval:true})
  const messages=[]
  worker.on('message',value=>messages.push(value))
  try{
    const exit=new Promise((resolve,reject)=>{worker.once('exit',resolve);worker.once('error',reject)})
    assert.equal(worker.unref(),undefined)
    assert.equal(worker.ref(),undefined)
    worker.postMessage('start')
    assert.equal(await exit,0)
    assert.deepEqual(messages,['finished'])
  }finally{await worker.terminate()}
})

test('Node snapshots workerData and detaches constructor transfers immediately',async()=>{
  const bytes=new Uint8Array([8,9]),data={bytes,label:'initial'}
  const worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads');
    parentPort.postMessage({label:workerData.label,bytes:[...workerData.bytes]});`,
    {eval:true,workerData:data,transferList:[bytes.buffer]})
  try{
    assert.equal(bytes.byteLength,0)
    data.label='changed'
    const result=await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)})
    assert.deepEqual(result,{label:'initial',bytes:[8,9]})
  }finally{await worker.terminate()}
})

test('Node transfers buffers posted before a worker installs its listener',async()=>{
  const worker=new Worker(`const {parentPort}=require('node:worker_threads');
    setTimeout(()=>parentPort.once('message',message=>{
      const bytes=new Uint8Array([7,8]);
      parentPort.postMessage({received:[...message.bytes],bytes},[bytes.buffer]);
      if(bytes.byteLength!==0)throw Error('Reply did not detach');
      parentPort.close();
    }),20);`,{eval:true})
  const response=new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)})
  const exit=new Promise((resolve,reject)=>{worker.once('exit',resolve);worker.once('error',reject)})
  try{
    const bytes=new Uint8Array([4,5,6])
    worker.postMessage({bytes},[bytes.buffer])
    assert.equal(bytes.byteLength,0)
    const result=await response
    assert.deepEqual(result.received,[4,5,6])
    assert.deepEqual([...result.bytes],[7,8])
    assert.equal(await exit,0)
  }finally{await worker.terminate()}
})
