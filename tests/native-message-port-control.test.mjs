import {test} from 'node:test'
import assert from 'node:assert/strict'
import {MessageChannel,receiveMessageOnPort} from 'node:worker_threads'

test('Node local port close notification is asynchronous and emitted once',async()=>{
  const {port1,port2}=new MessageChannel(),events=[]
  const closed=new Promise(resolve=>port1.on('close',()=>{events.push('close');resolve()}))
  try{
    port1.close();port1.close()
    events.push('returned')
    assert.deepEqual(events,['returned'])
    await closed
    assert.deepEqual(events,['returned','close'])
  }finally{port2.close()}
})

test('Node synchronously takes queued messages without emitting them to listeners',async()=>{
  const {port1,port2}=new MessageChannel(),received=[]
  try{
    port1.on('message',value=>received.push(value))
    port2.postMessage({answer:42})
    assert.deepEqual(receiveMessageOnPort(port1),{message:{answer:42}})
    assert.equal(receiveMessageOnPort(port1),undefined)
    await new Promise(resolve=>setImmediate(resolve))
    assert.deepEqual(received,[])
  }finally{port1.close();port2.close()}
})

test('Node port listener lifetime and once removal control',async()=>{
  const {port1,port2}=new MessageChannel()
  const callback=()=>{}
  try{
    assert.equal(port1.hasRef(),false)
    port1.on('close',callback)
    port1.on('messageerror',callback)
    assert.equal(port1.hasRef(),false)
    port1.on('message',callback)
    assert.equal(port1.hasRef(),true)
    port1.unref()
    port1.on('message',()=>{})
    assert.equal(port1.hasRef(),false)
    port1.removeAllListeners()
    await new Promise((resolve,reject)=>{
      port1.once('message',()=>{
        try{assert.equal(port1.hasRef(),false);resolve()}catch(error){reject(error)}
      })
      assert.equal(port1.hasRef(),true)
      port2.postMessage(42)
    })
  }finally{port1.close();port2.close()}
})
