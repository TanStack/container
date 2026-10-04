import test from 'node:test'
import assert from 'node:assert/strict'
import {runInNewContext} from 'node:vm'
import {installNativeWorkerIOObservation} from '../scripts/native-worker-io-observation.mjs'

const ownerOrigin='https://owner.invalid',parentOrigin='https://parent.invalid'
function fixture({origin=ownerOrigin,maxEvents=256,maxPending=128,consoleThrows=false}={}){
  const listeners={},parent={},sent=[],logs=[];let time=0,sendError
  class Target{
    listeners=[]
    addEventListener(_name,listener){this.listeners.push(listener)}
    emit(data){for(const listener of this.listeners)listener({data})}
    postMessage(...args){if(sendError)throw sendError;sent.push({target:this,args});return 'original result'}
  }
  class Worker extends Target{}
  class MessagePort extends Target{}
  const context={location:{origin},parent,Worker,MessagePort,performance:{now:()=>time},
    addEventListener:(name,listener)=>listeners[name]=listener,
    console:{info:value=>{if(consoleThrows)throw Error('cannot log');logs.push(value)}},
  }
  runInNewContext(`(${installNativeWorkerIOObservation.toString()})(${JSON.stringify({ownerOrigin,parentOrigin,maxEvents,maxPending})})`,context)
  const connect=port=>listeners.message?.({origin:parentOrigin,source:parent,data:{protocol:'native-owner-v1',type:'connect'},ports:[port]})
  return {context,Worker,MessagePort,connect,sent,logs,setTime:value=>time=value,setError:value=>sendError=value,
    rows:()=>JSON.parse(JSON.stringify(context.__nativeWorkerIOObservation?.rows))}
}

test('worker observation preserves messages, transfers and results without reading payloads',()=>{
  const f=fixture(),worker=new f.Worker(),bytes=new Uint8Array([1,2]),transfer=[bytes.buffer]
  const connect={id:1,operation:'connect',privateValue:'secret'}
  assert.equal(worker.postMessage(connect,transfer),'original result')
  assert.equal(f.sent[0].args[0],connect);assert.equal(f.sent[0].args[1],transfer)
  worker.emit({id:1,ok:true,value:{socketId:4,privateValue:'secret'}})
  worker.postMessage({id:2,operation:'write',socketId:4,bytes},transfer)
  f.setTime(12);worker.emit({id:2,ok:true})
  worker.postMessage({id:3,operation:'read',socketId:4})
  worker.emit({id:3,ok:true,value:{type:'data',bytes}})
  assert.equal(f.sent.length,3)
  assert.equal(f.rows().filter(row=>row.kind==='worker-response').at(-1).bytes,2)
  assert.equal(f.rows().find(row=>row.operation==='write'&&row.kind==='worker-response').waitMs,12)
  assert.ok(!JSON.stringify(f.rows()).includes('secret'))
})

test('snapshot runs before the application handles dispose and keeps pending calls despite tail drops',()=>{
  const f=fixture({maxEvents:2}),port=new f.MessagePort(),worker=new f.Worker()
  f.connect(port)
  worker.postMessage({id:1,operation:'connect'});worker.emit({id:1,ok:true,value:{socketId:7}})
  worker.postMessage({id:2,operation:'read',socketId:7})
  const request=(id,operation)=>({protocol:'native-owner-v1',type:'request',id,operation})
  port.emit(request(1,'fetch'))
  let beforeApplication
  port.addEventListener('message',()=>{beforeApplication=f.rows().at(-1)})
  port.emit(request(2,'dispose'))
  assert.equal(beforeApplication.kind,'snapshot')
  assert.deepEqual(beforeApplication.pendingWorker.map(row=>row.operation),['read'])
  assert.deepEqual(beforeApplication.pendingOwner.map(row=>row.operation),['fetch','dispose'])
  assert.deepEqual(beforeApplication.sockets,[{worker:1,socketId:7}])
  assert.ok(beforeApplication.dropped>0)
  assert.equal(f.sent.length,2)
  port.postMessage({protocol:'native-owner-v1',type:'response',id:1,ok:true,value:{status:200,hasBody:true,headers:[['secret','value']]}})
  assert.equal(f.rows().at(-1).kind,'owner-response')
  assert.ok(!JSON.stringify(f.rows()).includes('secret'))
})

test('foreign origins, pending caps and failed recording do not alter send errors',()=>{
  const outside=fixture({origin:'https://preview.invalid'})
  assert.equal(outside.context.__nativeWorkerIOObservation,undefined)
  const f=fixture({maxPending:1,consoleThrows:true}),worker=new f.Worker()
  worker.postMessage({id:1,operation:'read',socketId:1})
  worker.postMessage({id:2,operation:'read',socketId:2})
  assert.equal(f.context.__nativeWorkerIOObservation.pendingDropped,1)
  const error=Error('original send failure');f.setError(error)
  assert.throws(()=>worker.postMessage({id:3,operation:'read',socketId:3}),reason=>reason===error)
  assert.equal(f.rows().at(-1).kind,'worker-send-threw')
})
