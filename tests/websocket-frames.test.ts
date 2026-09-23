import {it,expect} from 'vitest'
import {WebSocketFrames,encodeWebSocketFrame,websocketMessageLimit} from '../src/sandbox/websocket-frames'
const bytes=(values:number[])=>new Uint8Array(values)
function reader(values:number[],split=1){
  const data=bytes(values);let offset=0
  return new WebSocketFrames(async()=>{if(offset===data.length)return null;const part=data.slice(offset,offset+split);offset+=part.length;return part})
}
it('matches the RFC masked Hello example',()=>{
  expect([...encodeWebSocketFrame(1,new TextEncoder().encode('Hello'),bytes([0x37,0xfa,0x21,0x3d]))]).toEqual([0x81,0x85,0x37,0xfa,0x21,0x3d,0x7f,0x9f,0x4d,0x51,0x58])
})
for(const split of [1,2,3,65536])it(`handles fragmented UTF-8 with interleaved control frames, split ${split}`,async()=>{
  const frames=reader([1,1,0xe2,0x89,1,42,0,1,0x82,0x80,1,0xac,0x8a,0,0x88,2,3,232],split)
  expect(await frames.read()).toEqual({type:'ping',data:bytes([42])})
  expect(await frames.read()).toEqual({type:'text',data:'€'})
  expect(await frames.read()).toEqual({type:'pong',data:bytes([])})
  expect(await frames.read()).toEqual({type:'close',code:1000,reason:'',data:bytes([3,232])})
  expect(await frames.read()).toBeNull()
})
for(const length of [0,125,126,65535,65536,websocketMessageLimit])it(`handles binary length ${length}`,async()=>{
  const payload=new Uint8Array(length).fill(7),encoded=encodeWebSocketFrame(2,payload,bytes([0,0,0,0]))
  const prefix=length<126?2:length<65536?4:10
  const wire=new Uint8Array(prefix+length);wire.set(encoded.subarray(0,prefix));wire[1]&=127;wire.set(encoded.subarray(prefix+4),prefix)
  let offset=0
  const parser=new WebSocketFrames(async()=>{if(offset===wire.length)return null;const part=wire.slice(offset,offset+16384);offset+=part.length;return part})
  const event=await parser.read();expect(event?.type).toBe('binary');expect(event?.data).toEqual(payload)
})
for(const [name,wire,code] of [
  ['mask',[0x81,0x80],1002],['reserved bits',[0xc1,0],1002],['unknown opcode',[0x83,0],1002],
  ['unexpected continuation',[0x80,0],1002],['second initial frame',[1,0,1,0],1002],
  ['fragmented ping',[9,0],1002],['large ping',[0x89,126],1002],
  ['short extended length',[0x82,126,0,125],1002],['short 64-bit length',[0x82,127,0,0,0,0,0,0,0,126],1002],
  ['high bit length',[0x82,127,128,0,0,0,0,0,0,0],1002],['huge length',[0x82,127,0,0,0,1,0,0,0,0],1009],
  ['invalid text',[0x81,1,255],1007],['truncated text',[0x81,1,0xe2],1007],
  ['close one byte',[0x88,1,3],1002],['reserved close code',[0x88,2,3,237],1002],
  ['invalid reason',[0x88,3,3,232,255],1007],['unexpected EOF',[0x82,3,1],1006],
] as const)it(`rejects ${name}`,async()=>{
  const frames=reader([...wire]);await expect(frames.read()).rejects.toMatchObject({code});expect(await frames.read()).toBeNull()
})
it('preserves the UTF-8 BOM as message content',async()=>{
  expect(await reader([0x81,3,239,187,191]).read()).toEqual({type:'text',data:'\ufeff'})
})
it('caps zero-byte fragmentation',async()=>{
  const wire=[1,0];for(let i=0;i<4096;i++)wire.push(0,0)
  await expect(reader(wire,65536).read()).rejects.toMatchObject({code:1009})
})
