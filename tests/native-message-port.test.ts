import {expect,test} from 'vitest'
import {nodeMessagePort,adaptTransferredPorts} from '../src/native/message-port'

test('transferred ports regain methods once while preserving cycles and shared identity',async()=>{
  const channel=new globalThis.MessageChannel()
  const original:any={port:channel.port1}
  original.self=original
  original.map=new Map([[channel.port1,new Set([channel.port1])]])
  const payload=structuredClone(original,{transfer:[channel.port1]})
  expect(adaptTransferredPorts(payload)).toBe(payload)
  expect(payload.self).toBe(payload)
  expect([...payload.map.keys()][0]).toBe(payload.port)
  expect([...payload.map.values()][0].has(payload.port)).toBe(true)
  const on=payload.port.on
  expect(adaptTransferredPorts(payload).port.on).toBe(on)
  try{
    const answer=new Promise(resolve=>payload.port.once('message',resolve))
    channel.port2.postMessage(42)
    expect(await answer).toBe(42)
  }finally{payload.port.close();channel.port2.close()}
})

test('port event adapter forwards values, removes listeners and closes once',async()=>{
  class Port extends EventTarget{
    starts=0;closes=0
    start(){this.starts++}
    close(){this.closes++}
  }
  const raw=new Port()
  const port=nodeMessagePort(raw as unknown as MessagePort)
  const values:unknown[]=[]
  expect(port.hasRef()).toBe(false)
  const listener=function(this:unknown,value:unknown){expect(this).toBe(port);values.push(value)}
  expect(port.on('message',listener)).toBe(port)
  expect(port.hasRef()).toBe(true)
  raw.dispatchEvent(new MessageEvent('message',{data:{value:5}}))
  port.off('message',listener)
  expect(port.hasRef()).toBe(false)
  raw.dispatchEvent(new MessageEvent('message',{data:6}))
  port.once('message',listener)
  expect(port.hasRef()).toBe(true)
  raw.dispatchEvent(new MessageEvent('message',{data:7}))
  expect(port.hasRef()).toBe(false)
  raw.dispatchEvent(new MessageEvent('message',{data:8}))
  expect(values).toEqual([{value:5},7])
  let closed=0
  port.on('close',()=>closed++)
  expect(port.hasRef()).toBe(false)
  port.close();port.close()
  expect(closed).toBe(0)
  await Promise.resolve()
  expect(closed).toBe(1)
  expect(raw.closes).toBe(1)
})

test('an explicit unref survives additional message listeners until all are removed',()=>{
  class Port extends EventTarget{start(){} close(){}}
  const port=nodeMessagePort(new Port() as unknown as MessagePort)
  const first=()=>{},second=()=>{}
  port.on('messageerror',first)
  expect(port.hasRef()).toBe(false)
  port.on('message',first)
  port.unref()
  port.on('message',second)
  expect(port.hasRef()).toBe(false)
  port.removeAllListeners('message')
  port.on('message',first)
  expect(port.hasRef()).toBe(true)
  port.removeAllListeners()
  expect(port.hasRef()).toBe(false)
  port.once('message',first)
  expect(port.hasRef()).toBe(true)
  port.dispatchEvent(new MessageEvent('message',{data:42}))
  expect(port.hasRef()).toBe(false)
  port.close()
})
