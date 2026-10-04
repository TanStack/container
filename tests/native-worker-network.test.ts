import {expect,test} from 'vitest'
import {socketBytesForTransfer} from '../src/native/socket-transfer'
import {bridgeWorkerSocket} from '../src/native/worker-socket-bridge'

test('socket chunks can share a source buffer across transferred messages',async()=>{
  const source=new Uint8Array([1,2,3,4])
  const first=source.subarray(0,2)
  const second=source.subarray(2)
  const {port1,port2}=new MessageChannel()
  const received:Uint8Array[]=[]
  const delivered=new Promise<void>(resolve=>{
    port2.onmessage=event=>{received.push(event.data);if(received.length===2)resolve()}
  })
  try{
    const firstTransfer=socketBytesForTransfer(first)
    port1.postMessage(firstTransfer,[firstTransfer.buffer])
    expect(source.byteLength).toBe(4)
    const secondTransfer=socketBytesForTransfer(second)
    port1.postMessage(secondTransfer,[secondTransfer.buffer])
    await delivered
    expect(received.map(bytes=>[...bytes])).toEqual([[1,2],[3,4]])
  }finally{
    port1.close()
    port2.close()
  }
})

test('closing a forwarded socket closes its peer socket',async()=>{
  const {port1,port2}=new MessageChannel()
  let firstClosed=0,secondClosed=0
  let secondClosedDone!:()=>void
  const peerClosed=new Promise<void>(resolve=>{secondClosedDone=resolve})
  const first={read:()=>new Promise<null>(()=>{}),write:async()=>{},end:async()=>{},
    close:async()=>{firstClosed++}}
  const second={read:()=>new Promise<null>(()=>{}),write:async()=>{},end:async()=>{},
    close:async()=>{secondClosed++;secondClosedDone()}}
  const closeFirst=bridgeWorkerSocket(first,port1)
  bridgeWorkerSocket(second,port2)
  await closeFirst()
  await peerClosed
  expect(firstClosed).toBe(1)
  expect(secondClosed).toBe(1)
})
