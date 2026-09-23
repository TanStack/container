import {test,expect} from 'vitest'
import {MessageChannel as NativeChannel,receiveMessageOnPort as nativeReceive} from 'node:worker_threads'
// @ts-expect-error Guest JavaScript is compared with Node directly.
import {MessageChannel,receiveMessageOnPort} from '../src/sandbox/guest-events.js'

async function probe(Channel:any,receive:any){
  const {port1,port2}=new Channel(),events:unknown[]=[]
  try{
    port2.onmessage=(event:any)=>events.push(event.data)
    const value={nested:{answer:42}}
    port1.postMessage(value);value.nested.answer=0
    port1.postMessage(undefined)
    const first=receive(port2),second=receive(port2),empty=receive(port2)
    await new Promise(resolve=>setTimeout(resolve,20))
    const consumedEvents=events.slice()
    const delivered=new Promise(resolve=>{port2.onmessage=(event:any)=>{events.push(event.data);resolve(event.data)}})
    port1.postMessage('event')
    await delivered
    return {first,second,empty,consumedEvents,events,after:receive(port2)}
  }finally{port1.close();port2.close()}
}
test('synchronous port reads match Node without duplicate event delivery',async()=>{
  expect(await probe(MessageChannel,receiveMessageOnPort)).toEqual(await probe(NativeChannel,nativeReceive))
})
test('invalid ports reject and close-pending queues remain synchronously readable',()=>{
  for(const [Channel,receive] of [[MessageChannel,receiveMessageOnPort],[NativeChannel,nativeReceive]] as any){
    for(const port of [null,{},undefined])expect(()=>receive(port)).toThrow()
    const {port1,port2}=new Channel();port1.postMessage(42);port2.close()
    expect(receive(port2)).toEqual({message:42});expect(receive(port2)).toBeUndefined();port1.close()
  }
})
