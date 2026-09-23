import {readFileSync} from 'node:fs'
import {EventEmitter} from 'node:events'
import {expect,it} from 'vitest'
import '../src/sandbox/guest-task-queue.js'

const factory=new Function(`${readFileSync('src/sandbox/guest-routed-ports.js','utf8')};return createRoutedPorts`)()

for(const asynchronous of [false,true])for(const fails of [false,true]){
  it(`${asynchronous?'async':'sync'} port delivery acknowledges after ${fails?'failed':'successful'} decode`,async()=>{
    const events:string[]=[]
    let sent=false
    const delivery={token:1,bytes:[42]}
    const host={proc:{
      call(method:string){
        if(method==='routedPortPair')return [1,2]
        if(method==='routedPortTake')return delivery
        if(method==='routedPortAck')events.push('ack')
      },
      portNext(){if(!sent){sent=true;return Promise.resolve(delivery)}return new Promise(()=>{})},
    }}
    const ports=factory(host,EventEmitter,()=>{},()=>{
      events.push('decode')
      if(fails)throw Error('decode failed')
      return 42
    })
    const {port1}=new ports.MessageChannel()
    if(asynchronous){
      const completed=new Promise<void>(resolve=>{
        port1.on('message',(value:unknown)=>{expect(value).toBe(42);events.push('message');resolve()})
        port1.on('messageerror',()=>{events.push('error');resolve()})
      })
      await completed
      expect(events).toEqual(['decode','ack',fails?'error':'message'])
    }else{
      if(fails)expect(()=>ports.receiveMessageOnPort(port1)).toThrow('decode failed')
      else expect(ports.receiveMessageOnPort(port1)).toEqual({message:42})
      expect(events).toEqual(['decode','ack'])
    }
    port1.close()
  })
}
