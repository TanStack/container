import {expect,test} from 'vitest'
import {EventEmitter} from 'node:events'
import {trackIpcChannelLifetime} from '../src/native/ipc-channel-lifetime'

test('IPC lifetime follows attached message and disconnect listeners',()=>{
  const events=new EventEmitter()
  let active=0
  const channel=trackIpcChannelLifetime(events,()=>{active++;return ()=>{active--}})
  expect(active).toBe(0)
  const message=()=>{},disconnected=()=>{}
  events.on('message',message)
  events.on('disconnect',disconnected)
  expect(active).toBe(1)
  events.off('message',message)
  expect(active).toBe(1)
  events.off('disconnect',disconnected)
  expect(active).toBe(0)
  events.once('message',message)
  expect(active).toBe(1)
  events.emit('message',42)
  expect(active).toBe(0)
  channel.dispose()
})
test('disconnect and cleanup release once and prevent new references',()=>{
  const events=new EventEmitter()
  events.on('message',()=>{})
  let active=0
  const channel=trackIpcChannelLifetime(events,()=>{active++;return ()=>{active--}})
  expect(active).toBe(1)
  channel.disconnect()
  channel.disconnect()
  events.on('message',()=>{})
  expect(active).toBe(0)
  channel.dispose()
  expect(events.listenerCount('newListener')).toBe(0)
  expect(events.listenerCount('removeListener')).toBe(0)
})
