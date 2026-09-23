import {it,expect} from 'vitest'
import {createHash} from 'node:crypto'
import {WorkerWebSocket} from '../src/sandbox/worker-websocket'
function peer(change:(headers:string)=>string=header=>header,frames:number[]=[]){
  const writes:Uint8Array[]=[];let response:Uint8Array|undefined,closed=0,connected=0
  const socket={port:9010,remotePort:1,async write(bytes:Uint8Array){
    writes.push(bytes.slice())
    if(writes.length!==1)return
    const request=new TextDecoder().decode(bytes),key=/Sec-WebSocket-Key: (.+)\r\n/.exec(request)![1]
    const accept=createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    const header=change(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: vite-hmr\r\n`)
    const bytesHead=new TextEncoder().encode(header+'\r\n');response=new Uint8Array(bytesHead.length+frames.length);response.set(bytesHead);response.set(frames,bytesHead.length)
  },async read(){if(!response)return null;const bytes=response;response=undefined;return {type:'data' as const,bytes}},async end(){},async close(){closed++}}
  return {writes,get closed(){return closed},get connected(){return connected},kernel:{async connect(port:number){expect(port).toBe(9010);connected++;return socket}}}
}
const open=(p:ReturnType<typeof peer>)=>WorkerWebSocket.connect(p.kernel,9010,'https://preview.invalid','wss://preview.invalid/?token=abc',['vite-hmr'])
for(const address of ['wss://other.invalid/','ws://preview.invalid/','wss://preview.invalid:8443/','wss://user:pass@preview.invalid/','wss://preview.invalid/#fragment'])it(`denies ${address} before connecting`,async()=>{
  const p=peer();await expect(WorkerWebSocket.connect(p.kernel,9010,'https://preview.invalid',address)).rejects.toThrow();expect(p.connected).toBe(0)
})
it('routes a guest loopback address while preserving its advertised Host header',async()=>{
  const p=peer();const socket=await WorkerWebSocket.connect(p.kernel,9010,'https://preview.invalid','ws://localhost:3000/?token=abc',['vite-hmr'])
  const request=new TextDecoder().decode(p.writes[0])
  expect(request).toContain('\r\nHost: localhost:3000\r\n')
  expect(request).toContain('\r\nOrigin: http://localhost:3000\r\n')
  await socket.dispose()
})
for(const [name,change] of [
  ['status',(s:string)=>s.replace('101 Switching Protocols','400 Bad Request')],
  ['accept',(s:string)=>s.replace(/Sec-WebSocket-Accept: .+\r\n/,'Sec-WebSocket-Accept: wrong\r\n')],
  ['protocol',(s:string)=>s.replace('vite-hmr','other')],
  ['extensions',(s:string)=>s+'Sec-WebSocket-Extensions: permessage-deflate\r\n'],
  ['duplicate',(s:string)=>s+'Upgrade: websocket\r\n'],
  ['connection',(s:string)=>s.replace('Connection: Upgrade','Connection: close')],
] as const)it(`rejects invalid ${name} and closes the socket`,async()=>{
  const p=peer(change);await expect(open(p)).rejects.toThrow();expect(p.closed).toBe(1)
})
it('replies to ping, delivers text and echoes close with masked frames',async()=>{
  const p=peer(undefined,[0x89,1,42,0x81,2,111,107,0x88,2,3,232]),ws=await open(p)
  expect(await ws.next()).toEqual({type:'text',data:'ok'})
  expect(await ws.next()).toMatchObject({type:'close',code:1000})
  const unpack=(frame:Uint8Array)=>[...frame.subarray(6)].map((byte,index)=>byte^frame[2+index%4])
  expect(p.writes[1][0]).toBe(0x8a);expect(p.writes[1][1]&128).toBe(128);expect(unpack(p.writes[1])).toEqual([42])
  expect(p.writes[2][0]).toBe(0x88);expect(unpack(p.writes[2])).toEqual([3,232])
  expect(p.closed).toBe(1);await ws.dispose();expect(p.closed).toBe(1)
})
