import {expect,it,vi} from 'vitest'
import {NativeTerminalInput} from '../src/native/terminal-input'

it('acknowledges a queued chunk only when the input reader takes it',async()=>{
  let receive!: (event:{data:any})=>void
  const postMessage=vi.fn(),port={set onmessage(value:any){receive=value},start:vi.fn(),close:vi.fn(),postMessage}
  const input=new NativeTerminalInput(port as never)
  const bytes=new Uint8Array([0,128,255])
  receive({data:{type:'data',id:1,bytes}})
  expect(postMessage).not.toHaveBeenCalled()
  expect(await input.read()).toEqual(bytes)
  expect(postMessage).toHaveBeenCalledWith({type:'consumed',id:1})
  input.close()
})

it('retains queued acknowledgements through EOF until the reader drains input',async()=>{
  let receive!: (event:{data:any})=>void
  const port={set onmessage(value:any){receive=value},start:vi.fn(),close:vi.fn(),postMessage:vi.fn()}
  const input=new NativeTerminalInput(port as never)
  receive({data:{type:'data',id:2,bytes:new Uint8Array([1])}})
  receive({data:{type:'end'}})
  expect(port.close).not.toHaveBeenCalled()
  await input.read()
  expect(port.postMessage).toHaveBeenCalledWith({type:'consumed',id:2})
  expect(port.close).toHaveBeenCalledOnce()
  expect(await input.read()).toBeNull()
})

it('receives chunks and EOF from one command port',async()=>{
  const channel=new MessageChannel()
  const input=new NativeTerminalInput(channel.port2)
  try{
    const pending=input.read()
    channel.port1.postMessage({type:'data',bytes:new Uint8Array([65,66])})
    expect(await pending).toEqual(new Uint8Array([65,66]))
    channel.port1.postMessage({type:'end'})
    expect(await input.read()).toBeNull()
  }finally{input.close();channel.port1.close()}
})

it('rejects malformed input and keeps non-interactive stdin at EOF',async()=>{
  expect(await new NativeTerminalInput().read()).toBeNull()
  const channel=new MessageChannel()
  const input=new NativeTerminalInput(channel.port2)
  try{
    const pending=input.read()
    channel.port1.postMessage({type:'data',bytes:'not bytes'})
    await expect(pending).rejects.toThrow('Invalid terminal input chunk')
  }finally{input.close();channel.port1.close()}
})

it('delivers resize events without consuming stdin',async()=>{
  const channel=new MessageChannel()
  const sizes:Array<[number,number]>=[]
  const input=new NativeTerminalInput(channel.port2,(columns,rows)=>sizes.push([columns,rows]))
  try{
    const pending=input.read()
    channel.port1.postMessage({type:'resize',columns:132,rows:41})
    channel.port1.postMessage({type:'data',bytes:new Uint8Array([65])})
    expect(await pending).toEqual(new Uint8Array([65]))
    expect(sizes).toEqual([[132,41]])
  }finally{input.close();channel.port1.close()}
})
