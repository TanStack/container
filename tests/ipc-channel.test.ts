import {test,expect} from 'vitest'
import {EventEmitter} from 'node:events'
import {AsyncLocalStorage} from 'node:async_hooks'
import {Buffer} from 'node:buffer'
import {ProcessMessageQueue} from '../src/sandbox/process-message-queue'
import '../src/sandbox/guest-task-queue.js'
// @ts-expect-error Guest source tested directly.
import {attachIPC} from '../src/sandbox/guest-ipc-channel.js'
// @ts-expect-error Guest source tested directly.
import {encodeIPC,decodeIPC} from '../src/sandbox/guest-ipc-codec.js'

test('IPC facade round trips messages, restores send context and disconnects once',async()=>{
  const queue=new ProcessMessageQueue(),target:any=new EventEmitter(),seen:any[]=[],als=new AsyncLocalStorage<string>()
  const host={proc:{call(method:string,_pid:number,bytes:number[]){
    if(method==='ipcSend')return queue.send(new Uint8Array(bytes))
    if(method==='ipcDisconnect')queue.end()
  },async ipcNext(){const bytes=await queue.receive();return bytes===null?null:Array.from(bytes)}},reportError(error:Error){throw error}}
  attachIPC(target,1,'advanced',host,Buffer,queueMicrotask,encodeIPC,decodeIPC)
  target.on('message',(message:any)=>{seen.push(message);target.disconnect()})
  target.on('disconnect',()=>seen.push('disconnect'))
  let callbackContext
  als.run('send',()=>target.send({answer:42n},(error:Error|null)=>{expect(error).toBeNull();callbackContext=als.getStore()}))
  await target._ipcDone
  expect(seen).toEqual([{answer:42n},'disconnect'])
  expect(callbackContext).toBe('send');expect(target.connected).toBe(false)
  const error=await new Promise<any>(resolve=>expect(target.send({},resolve)).toBe(false))
  expect(error.code).toBe('ERR_IPC_CHANNEL_CLOSED')
})
