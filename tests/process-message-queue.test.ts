import {test,expect,vi} from 'vitest'
import {ProcessMessageQueue} from '../src/sandbox/process-message-queue'

test('IPC messages are copied, ordered and drained before disconnect EOF',async()=>{
  const queue=new ProcessMessageQueue(),source=new Uint8Array([1,2])
  queue.send(source);source[0]=9;queue.send(new Uint8Array())
  queue.end()
  expect(queue.connected).toBe(false)
  expect(await queue.receive()).toEqual(new Uint8Array([1,2]))
  expect(await queue.receive()).toEqual(new Uint8Array())
  expect(await queue.receive()).toBeNull()
  expect(queue.queuedBytes).toBe(0)
  expect(()=>queue.send(source)).toThrow('IPC channel is closed')
})
test('IPC receive delivery copies data and rejects concurrent receives',async()=>{
  const queue=new ProcessMessageQueue(),source=new Uint8Array([42])
  const received=queue.receive()
  expect(()=>queue.receive()).toThrow('already pending')
  expect(queue.send(source)).toBe(true);source[0]=0
  expect(await received).toEqual(new Uint8Array([42]))
  const eof=queue.receive();queue.end();expect(await eof).toBeNull()
})
test('IPC queues bound bytes, message size and empty-message floods',async()=>{
  const queue=new ProcessMessageQueue(8,4,4)
  expect(queue.send(new Uint8Array(4))).toBe(false)
  queue.send(new Uint8Array(4))
  expect(()=>queue.send(new Uint8Array(1))).toThrow('queue is full')
  expect(()=>queue.send(new Uint8Array(5))).toThrow('byte limit')
  await queue.receive();expect(queue.queuedBytes).toBe(4)
  queue.send(new Uint8Array(4));queue.close();expect(queue.queuedBytes).toBe(0)
  const empty=new ProcessMessageQueue(8,2,4)
  empty.send(new Uint8Array());empty.send(new Uint8Array())
  expect(()=>empty.send(new Uint8Array())).toThrow('queue is full')
})
test('IPC termination releases a pending receiver and discards queued bytes',async()=>{
  const queue=new ProcessMessageQueue(),pending=queue.receive()
  const rejection=expect(pending).rejects.toThrow('terminated')
  queue.close(Error('terminated'));await rejection
  expect(await queue.receive()).toBeNull()
  const other=new ProcessMessageQueue();other.send(new Uint8Array([1]));other.close()
  expect(await other.receive()).toBeNull()
})

test('owned message resources survive queueing and graceful end until acknowledgment',async()=>{
  const queue=new ProcessMessageQueue(),resource={dispose:vi.fn()}
  queue.send(new Uint8Array([1]),[resource]);queue.end()
  expect(()=>queue.take()).toThrow('acknowledged')
  expect(()=>queue.takeLease()).toThrow('acknowledged')
  expect(()=>queue.receive()).toThrow('acknowledged')
  const delivery=queue.takeDelivery()!
  expect(await queue.receiveLease()).toEqual(delivery)
  expect(queue.takeDelivery()).toEqual(delivery)
  expect(resource.dispose).not.toHaveBeenCalled()
  expect(()=>queue.takeLease()).toThrow('acknowledged')
  queue.ackReceive(delivery.token)
  expect(resource.dispose).toHaveBeenCalledTimes(1)
  expect(()=>queue.ackReceive(delivery.token)).toThrow('acknowledgement')
  expect(await queue.receiveLease()).toBeNull()
  queue.close();expect(resource.dispose).toHaveBeenCalledTimes(1)
})

test('direct acknowledged delivery retains resources until explicit drop',async()=>{
  const queue=new ProcessMessageQueue(),resource={dispose:vi.fn()},pending=queue.receiveLease()
  queue.send(new Uint8Array([2]),[resource])
  const delivery=(await pending)!
  queue.cancelReceive();queue.end()
  expect(resource.dispose).not.toHaveBeenCalled()
  expect(queue.queuedBytes).toBe(1)
  queue.dropReceive(delivery.token)
  expect(resource.dispose).toHaveBeenCalledTimes(1)
  expect(queue.queuedBytes).toBe(0)
})

test('cancelled readers leave queued and in-flight resources available to the next owner',async()=>{
  const queue=new ProcessMessageQueue(),pending=queue.receiveLease(),resource={dispose:vi.fn()}
  queue.cancelReceive();expect(await pending).toBeNull()
  queue.send(new Uint8Array([3]),[resource])
  const first=await queue.receiveLease()
  queue.cancelReceive()
  expect(await queue.receiveLease()).toEqual(first)
  expect(resource.dispose).not.toHaveBeenCalled()
  queue.close();expect(resource.dispose).toHaveBeenCalledTimes(1)
})

test('close releases all queued and in-flight resources once even when a disposer throws',()=>{
  const queue=new ProcessMessageQueue(),a={dispose:vi.fn(()=>{throw Error('release failed')})},b={dispose:vi.fn()}
  queue.send(new Uint8Array([1]),[a]);queue.send(new Uint8Array([2]),[b]);queue.takeDelivery()
  expect(()=>queue.close()).toThrow('release failed')
  expect(a.dispose).toHaveBeenCalledTimes(1);expect(b.dispose).toHaveBeenCalledTimes(1)
  expect(queue.queuedBytes).toBe(0)
  queue.close()
  expect(a.dispose).toHaveBeenCalledTimes(1);expect(b.dispose).toHaveBeenCalledTimes(1)
})

test('rejected sends retain caller ownership and leave a waiting byte reader intact',async()=>{
  const queue=new ProcessMessageQueue(4,1,4),resource={dispose:vi.fn()},pending=queue.receive()
  expect(()=>queue.send(new Uint8Array([1]),[resource])).toThrow('acknowledged')
  queue.send(new Uint8Array([2]));expect(await pending).toEqual(new Uint8Array([2]))
  expect(()=>queue.send(new Uint8Array(5),[resource])).toThrow('byte limit')
  queue.send(new Uint8Array(4))
  expect(()=>queue.send(new Uint8Array([1]),[resource])).toThrow('queue is full')
  queue.close()
  expect(()=>queue.send(new Uint8Array([1]),[resource])).toThrow('closed')
  expect(resource.dispose).not.toHaveBeenCalled()
})

test('false backpressure transfers resources and duplicate resources are rejected',()=>{
  const queue=new ProcessMessageQueue(4,2,4),resource={dispose:vi.fn()}
  expect(()=>queue.send(new Uint8Array([1]),[resource,resource])).toThrow('resources')
  expect(queue.send(new Uint8Array(3),[resource])).toBe(false)
  expect(resource.dispose).not.toHaveBeenCalled()
  queue.close();expect(resource.dispose).toHaveBeenCalledTimes(1)
})
