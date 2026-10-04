import {expect,it} from 'vitest'
import {NativeCommandInputTransport} from '../src/native/command-input-transport'

it('queues before startup and waits for each input acknowledgement',async()=>{
  const messages:any[]=[]
  const input=new NativeCommandInputTransport(message=>messages.push(message))
  const bytes=new Uint8Array([255,0])
  const first=input.write(bytes),second=input.write(new Uint8Array([2])),end=input.write(null)
  bytes.fill(9)
  expect(messages).toHaveLength(0)
  input.start();input.start()
  expect(messages).toHaveLength(1)
  expect([...messages[0].bytes]).toEqual([255,0])
  input.acknowledge(999)
  expect(messages).toHaveLength(1)
  input.acknowledge(messages[0].inputId);await first
  expect(messages).toHaveLength(2)
  input.acknowledge(messages[0].inputId)
  expect(messages).toHaveLength(2)
  input.acknowledge(messages[1].inputId);await second
  expect(messages[2].bytes).toBeNull()
  input.acknowledge(messages[2].inputId);await end
  expect(()=>input.write(new Uint8Array([3]))).toThrow('closed')
})

it('bounds queued input and rejects pending writes when closed',async()=>{
  const input=new NativeCommandInputTransport(()=>{})
  const receipts=Array.from({length:16},()=>input.write(new Uint8Array(65536)))
  const rejected=Promise.all(receipts.map(receipt=>expect(receipt).rejects.toMatchObject({code:'EPIPE'})))
  expect(()=>input.write(new Uint8Array([1]))).toThrow('queue is full')
  input.close();input.close()
  await rejected
  expect(()=>input.write(null)).toThrow('closed')
})

it('rejects receipts when sending fails',async()=>{
  const error=Error('transport closed')
  const input=new NativeCommandInputTransport(()=>{throw error})
  const receipt=input.write(new Uint8Array([1]))
  const rejected=expect(receipt).rejects.toBe(error)
  input.start()
  await rejected
})
