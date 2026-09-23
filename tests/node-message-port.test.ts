import {test,expect} from 'vitest'
import {MessageChannel as NativeChannel} from 'node:worker_threads'
// @ts-expect-error Guest sources tested against Node.
import {MessageChannel as BaseChannel,MessagePort as BasePort} from '../src/sandbox/guest-events.js'
// @ts-expect-error Guest sources tested against Node.
import {nodeMessagePorts} from '../src/sandbox/guest-node-message-port.js'
async function probe(Channel:any){
  const {port1,port2}=new Channel(),seen:any[]=[]
  try{
    const duplicate=(value:any)=>seen.push(['duplicate',value])
    port2.on('message',duplicate);port2.on('message',duplicate);port2.off('message',duplicate)
    port2.once('message',function(this:any,value:any){seen.push(['once',value,this===port2])})
    port2.addEventListener('message',(event:any)=>seen.push(['event',event.data]))
    for(const value of [1,2]){
      await new Promise<void>(resolve=>{port2.once('message',()=>resolve());port1.postMessage(value)})
    }
    seen.push(['listeners',port2.listenerCount('message')])
    port2.removeAllListeners('message')
    seen.push(['removed',port2.listenerCount('message'),port2.eventNames().includes('message')])
    return seen
  }finally{port1.close();port2.close()}
}
test('Node port listeners preserve ordering, duplicates, once and receiver',async()=>{
  const {MessageChannel}=nodeMessagePorts(BaseChannel,BasePort)
  expect(await probe(MessageChannel)).toEqual(await probe(NativeChannel))
})
