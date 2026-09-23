import {describe,it,expect} from 'vitest'
import {WorkerMessageTiming} from '../src/sandbox/worker-message-timing'
// @ts-expect-error The production guest codec is JavaScript loaded as guest source.
import {encodeIPC} from '../src/sandbox/guest-ipc-codec.js'

describe('worker message timing',()=>{
  it('streams immutable lifecycle snapshots while filtering routine messages',()=>{
    let now=1
    const events:unknown[]=[]
    const timing=new WorkerMessageTiming(()=>now,1,sample=>events.push(sample),true)
    const encode=(type:string)=>new TextEncoder().encode(encodeIPC({__emnapi__:{type,payload:{tid:3}}},'advanced'))
    timing.send(2,encode('async-send'))
    const settle=timing.receive(2,{token:1,bytes:encode('cleanup-thread')})!
    now=4;settle();settle()
    timing.send(2,encode('start'))
    expect(events).toHaveLength(2)
    expect(events[0]).not.toHaveProperty('settledAt')
    expect(events[1]).toMatchObject({settledAt:4,waitMs:3})
    expect(timing.samples).toHaveLength(1)
  })
  it('records bounded scalar lease-to-settlement timing without retaining bodies',()=>{
    let now=10
    const timing=new WorkerMessageTiming(()=>now,2)
    const bytes=new TextEncoder().encode(encodeIPC({__emnapi__:{type:'cleanup-thread',payload:{tid:43,secret:'not retained'}}},'advanced'))
    const original=bytes.slice(),settle=timing.receive(7,{token:2,bytes})!
    now=25;settle();now=30;settle()
    expect(timing.samples).toEqual([{kind:'receive',endpoint:7,token:2,receivedAt:10,settledAt:25,waitMs:15,protocol:'cleanup-thread',tid:43}])
    expect(bytes).toEqual(original)
    timing.receive(8,{token:3,bytes:new Uint8Array([255])})
    expect(timing.receive(9,{token:4,bytes})).toBeUndefined()
    expect(timing.samples).toHaveLength(2)
    expect(timing.samples[1]).toEqual({kind:'receive',endpoint:8,token:3,receivedAt:30})
    expect(JSON.stringify(timing.samples)).not.toContain('secret')
  })
  it('shares the default96sample cap between successful sends and receives',()=>{
    let now=1
    const timing=new WorkerMessageTiming(()=>now)
    const bytes=new TextEncoder().encode(encodeIPC({__emnapi__:{type:'cleanup-thread',payload:{tid:45}}},'advanced'))
    timing.send(2,bytes)
    expect(timing.samples[0]).toEqual({kind:'send',endpoint:2,sentAt:1,protocol:'cleanup-thread',tid:45})
    now=2
    const settle=timing.receive(2,{token:16,bytes})!
    for(let i=0;i<94;i++)timing.send(2,bytes)
    timing.send(2,bytes)
    expect(timing.receive(2,{token:17,bytes})).toBeUndefined()
    now=5;settle()
    expect(timing.samples).toHaveLength(96)
    expect(timing.samples[1]).toMatchObject({receivedAt:2,settledAt:5,waitMs:3})
  })
})
