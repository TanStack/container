import {expect,test} from 'vitest'
import {EventEmitter} from '../src/vite-browser/node-events'
import {createIpcMessageQueue} from '../src/native/ipc-message-queue'

test('startup completion retains messages for a later listener while IPC is open',async()=>{
  const events=new EventEmitter(),received:unknown[]=[]
  const queue=createIpcMessageQueue(events,value=>events.emit('message',value))
  queue.receive(42);queue.finishStartup()
  await Promise.resolve()
  events.on('message',value=>received.push(value))
  await Promise.resolve();await Promise.resolve()
  expect(received).toEqual([42])
})

test('disconnect follows queued startup messages',async()=>{
  const events=new EventEmitter(),order:unknown[]=[]
  const queue=createIpcMessageQueue(events,value=>events.emit('message',value))
  queue.receive('queued');queue.disconnect(()=>order.push('disconnect'))
  expect(order).toEqual([])
  events.on('message',value=>order.push(value))
  await Promise.resolve();await Promise.resolve()
  expect(order).toEqual(['queued','disconnect'])
})

test('startup completion drains unobserved messages without holding disconnect forever',async()=>{
  const events=new EventEmitter(),order:unknown[]=[]
  const queue=createIpcMessageQueue(events,value=>order.push(value))
  queue.receive('unobserved');queue.disconnect(()=>order.push('disconnect'));queue.finishStartup()
  await Promise.resolve()
  expect(order).toEqual(['disconnect'])
})

test('buffers fork messages until a message listener is attached',async()=>{
  const events=new EventEmitter(),received:unknown[]=[]
  const queue=createIpcMessageQueue(events,value=>events.emit('message',value))
  queue.receive(1)
  events.on('message',value=>received.push(value))
  queue.receive(2)
  expect(received).toEqual([])
  await Promise.resolve();await Promise.resolve()
  expect(received).toEqual([1,2])
  queue.receive(3)
  expect(received).toEqual([1,2,3])
})
