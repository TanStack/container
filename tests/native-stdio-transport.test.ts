import {expect,it,vi} from 'vitest'
import {NativeStdioTransport} from '../src/native/stdio-transport'

it('holds write completion and lifetime until each bounded chunk is acknowledged',()=>{
  const messages:any[]=[],release=vi.fn(),done=vi.fn()
  const transport=new NativeStdioTransport(message=>messages.push(message),()=>release)
  const bytes=Uint8Array.from({length:150000},(_,index)=>index%251)
  transport.write('stdout',bytes,done)
  expect(messages).toHaveLength(1)
  expect(done).not.toHaveBeenCalled()
  transport.acknowledge(messages[0].outputId)
  expect(messages).toHaveLength(2)
  transport.acknowledge(messages[0].outputId)
  expect(messages).toHaveLength(2)
  transport.acknowledge(messages[1].outputId)
  expect(messages).toHaveLength(3)
  expect(release).not.toHaveBeenCalled()
  transport.acknowledge(messages[2].outputId)
  expect(done).toHaveBeenCalledTimes(1)
  expect(release).toHaveBeenCalledTimes(1)
  expect(messages.map(message=>message.bytes.length)).toEqual([65536,65536,18928])
  expect(new Uint8Array(messages.flatMap(message=>[...message.bytes]))).toEqual(bytes)
})

it('releases the write when transport fails',()=>{
  const release=vi.fn(),done=vi.fn(),error=Error('closed')
  const transport=new NativeStdioTransport(()=>{throw error},()=>release)
  transport.write('stderr',new Uint8Array([255]),done)
  expect(done).toHaveBeenCalledWith(error)
  expect(release).toHaveBeenCalledTimes(1)
  transport.acknowledge(1)
  expect(done).toHaveBeenCalledTimes(1)
})
