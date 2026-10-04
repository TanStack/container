import {expect,it,vi} from 'vitest'
import {NativeTerminalInputSender} from '../src/native/terminal-input-sender'
import {NativeTerminalInput} from '../src/native/terminal-input'

it('ignores acknowledgements when no write is pending',()=>{
  let receive!:(event:{data:any})=>void
  const port={addEventListener:(_type:string,listener:any)=>{receive=listener},start:vi.fn(),postMessage:vi.fn()}
  const sender=new NativeTerminalInputSender(port as never)
  expect(()=>receive({data:{type:'consumed'}})).not.toThrow()
  expect(()=>receive({data:{type:'consumed',id:1}})).not.toThrow()
  sender.close()
})

it('only the pending write id can complete a write',async()=>{
  let receive!:(event:{data:any})=>void
  const postMessage=vi.fn(),port={addEventListener:(_type:string,listener:any)=>{receive=listener},start:vi.fn(),postMessage}
  const sender=new NativeTerminalInputSender(port as never),done=vi.fn()
  const writing=sender.write('hello').then(done)
  receive({data:{type:'consumed',id:999}})
  await Promise.resolve()
  expect(done).not.toHaveBeenCalled()
  receive({data:{type:'consumed',id:postMessage.mock.calls[0][0].id}})
  await writing
  expect(done).toHaveBeenCalledOnce()
  sender.close()
})

it('rejects invalid chunks before dispatch',async()=>{
  const channel=new MessageChannel(),sender=new NativeTerminalInputSender(channel.port1)
  try{
    for(const bytes of [new Uint8Array(),new Uint8Array(65537)])
      await expect(sender.write(bytes)).rejects.toThrow('Invalid')
  }finally{sender.close();channel.port1.close();channel.port2.close()}
})

it('waits for the reader and rejects concurrent writes',async()=>{
  const channel=new MessageChannel(),sender=new NativeTerminalInputSender(channel.port1)
  const receiver=new NativeTerminalInput(channel.port2),done=vi.fn()
  try{
    const writing=sender.write(new Uint8Array([0,128,255])).then(done)
    await expect(sender.write('second')).rejects.toThrow('pending')
    expect(done).not.toHaveBeenCalled()
    expect(await receiver.read()).toEqual(new Uint8Array([0,128,255]))
    await writing
    expect(done).toHaveBeenCalledOnce()
  }finally{sender.close();receiver.close();channel.port1.close()}
})

it('closing rejects a pending write and future input',async()=>{
  const channel=new MessageChannel(),sender=new NativeTerminalInputSender(channel.port1)
  try{
    const writing=sender.write('pending'),failure=expect(writing).rejects.toThrow('closed')
    sender.close();await failure
    await expect(sender.write('late')).rejects.toThrow('closed')
  }finally{channel.port1.close();channel.port2.close()}
})
