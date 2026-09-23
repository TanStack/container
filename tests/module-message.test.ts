import {test,expect} from 'vitest'
import {ModuleMessageBudget,ModuleMessageSender,moduleDelivery,type ModuleMessage} from '../src/sandbox/module-message'
import {ProcessMessageQueue} from '../src/sandbox/process-message-queue'

test('module bytes are immutable copies retained until envelope disposal',()=>{
  const budget=new ModuleMessageBudget(10),sender=new ModuleMessageSender(budget),input=new Uint8Array([1,2,3])
  const id=sender.retain(input);input[0]=9
  let envelope!:ModuleMessage
  expect(sender.send([id],message=>{envelope=message;return false})).toBe(false)
  sender.dispose();expect(budget.bytes).toBe(3)
  const first=envelope.adopt(id);expect([...first]).toEqual([1,2,3]);first[0]=8
  expect([...envelope.adopt(id)]).toEqual([1,2,3]);expect(budget.bytes).toBe(3)
  envelope.dispose();envelope.dispose();expect(budget.bytes).toBe(0)
  expect(()=>envelope.adopt(id)).toThrow('unavailable')
})
test('rejected acceptance leaves ownership pending for caller rollback',()=>{
  const budget=new ModuleMessageBudget(10),sender=new ModuleMessageSender(budget),id=sender.retain(new Uint8Array(4))
  expect(()=>sender.send([id],()=>{throw Error('queue full')})).toThrow('queue full')
  expect(budget.bytes).toBe(4);sender.release([id]);expect(budget.bytes).toBe(0)
})
test('budget failures and duplicate IDs leave accounting unchanged',()=>{
  const budget=new ModuleMessageBudget(4),sender=new ModuleMessageSender(budget),id=sender.retain(new Uint8Array(4))
  expect(()=>sender.retain(new Uint8Array(1))).toThrow('budget exceeded')
  expect(()=>sender.send([id,id],()=>{})).toThrow('Invalid')
  expect(()=>sender.release([id,id])).toThrow('Invalid');expect(budget.bytes).toBe(4)
  sender.dispose();expect(budget.bytes).toBe(0)
})
test('queue disposal releases accepted module envelopes',()=>{
  const budget=new ModuleMessageBudget(1024),sender=new ModuleMessageSender(budget),queue=new ProcessMessageQueue()
  const id=sender.retain(new Uint8Array(512))
  sender.send([id],message=>queue.send(new Uint8Array([1]),[message]))
  sender.dispose();expect(budget.bytes).toBe(512)
  queue.close();expect(budget.bytes).toBe(0)
})
test('module resources remain charged until delivery acknowledgment',()=>{
  const budget=new ModuleMessageBudget(1024),sender=new ModuleMessageSender(budget),queue=new ProcessMessageQueue()
  const id=sender.retain(new Uint8Array([42]))
  sender.send([id],message=>queue.send(new Uint8Array([1]),[message]))
  const delivery=queue.takeDelivery()!
  expect(moduleDelivery(queue.deliveryResources(delivery.token)).adopt(id)[0]).toBe(42)
  expect(budget.bytes).toBe(1)
  queue.ackReceive(delivery.token);expect(budget.bytes).toBe(0)
})

test('senders share one budget and a dropped delivery releases its reservation',()=>{
  const budget=new ModuleMessageBudget(6),first=new ModuleMessageSender(budget),second=new ModuleMessageSender(budget),queue=new ProcessMessageQueue()
  const id=first.retain(new Uint8Array(4))
  expect(()=>second.retain(new Uint8Array(3))).toThrow('budget exceeded')
  first.send([id],message=>queue.send(new Uint8Array([1]),[message]))
  const delivery=queue.takeDelivery()!
  queue.dropReceive(delivery.token);expect(budget.bytes).toBe(0)
  const next=second.retain(new Uint8Array(6));second.release([next]);expect(budget.bytes).toBe(0)
})

test('closed queue rejection preserves caller ownership and sender disposal is final',()=>{
  const budget=new ModuleMessageBudget(8),sender=new ModuleMessageSender(budget),queue=new ProcessMessageQueue()
  const id=sender.retain(new Uint8Array(8));queue.close()
  expect(()=>sender.send([id],message=>queue.send(new Uint8Array([1]),[message]))).toThrow('closed')
  expect(budget.bytes).toBe(8);sender.dispose();sender.dispose();expect(budget.bytes).toBe(0)
  expect(()=>sender.retain(new Uint8Array(1))).toThrow('disposed')
})
