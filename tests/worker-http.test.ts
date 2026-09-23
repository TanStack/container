import {describe,it,expect} from 'vitest'
import {readHTTPResponse,WorkerHTTP} from '../src/sandbox/worker-http'

function transport(wire:string, fragmented=false) {
  const bytes=new TextEncoder().encode(wire)
  const parts=fragmented?Array.from(bytes,x=>new Uint8Array([x])):[bytes]
  let closed=0,reads=0
  const socket={port:1,remotePort:2,async read(){reads++;return parts.length?{type:'data' as const,bytes:parts.shift()!}:{type:'end' as const}},async write(_bytes:Uint8Array){},async end(){},async close(){closed++}}
  return {socket,get closed(){return closed},get reads(){return reads}}
}
describe('worker HTTP response transport',()=>{
  for(const fragmented of [false,true])it(`decodes chunked bytes, informational headers and trailers (${fragmented})`,async()=>{
    const peer=transport('HTTP/1.1 103 Early Hints\r\nLink: </app.js>\r\n\r\nHTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: text/plain\r\n\r\n3\r\nabc\r\n2;test=yes\r\nde\r\n0\r\nX-Trailer: done\r\n\r\n',fragmented)
    const response=await readHTTPResponse(peer.socket,'GET',()=>peer.socket.close())
    expect(response.status).toBe(200);expect(response.headers.has('transfer-encoding')).toBe(false)
    expect(await response.text()).toBe('abcde');expect(peer.closed).toBe(1)
  })
  it('does not consume the body before the caller pulls, and closes on cancellation',async()=>{
    const peer=transport('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello',true)
    const response=await readHTTPResponse(peer.socket,'GET',()=>peer.socket.close())
    const reads=peer.reads
    await Promise.resolve();expect(peer.reads).toBe(reads)
    await response.body!.cancel();expect(peer.closed).toBe(1)
  })
  for(const body of ['Content-Length: 5\r\n\r\nabc','Transfer-Encoding: chunked\r\n\r\n5\r\nabc'])it(`rejects truncated ${body.slice(0,15)}`,async()=>{
    const peer=transport('HTTP/1.1 200 OK\r\n'+body)
    const response=await readHTTPResponse(peer.socket,'GET',()=>peer.socket.close())
    await expect(response.text()).rejects.toThrow('Truncated');expect(peer.closed).toBe(1)
  })
  for(const fields of ['Content-Length: 1\r\nContent-Length: 2','Transfer-Encoding: chunked\r\nContent-Length: 2','Transfer-Encoding: gzip','Content-Length: -1'])it(`rejects framing ${fields}`,async()=>{
    const peer=transport('HTTP/1.1 200 OK\r\n'+fields+'\r\n\r\n')
    const client=new WorkerHTTP({connect:async()=>peer.socket},1234)
    await expect(client.fetch(new Request('https://preview.invalid/'))).rejects.toThrow()
    expect(peer.closed).toBe(1)
  })
  it('preserves binary response bytes and strips connection-nominated headers',async()=>{
    const peer=transport('HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close, X-Private\r\nX-Private: secret\r\n\r\na\0b')
    const response=await readHTTPResponse(peer.socket,'GET',()=>peer.socket.close())
    expect(response.headers.has('x-private')).toBe(false)
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([97,0,98])
  })

  it('validates and applies the public response deadline',async()=>{
    for(const value of [NaN,0,10.5,120001])expect(()=>new WorkerHTTP({connect:async()=>transport('').socket},1234,{requestTimeoutMs:value})).toThrow('requestTimeoutMs')
    let finishRead:(value:any)=>void=()=>{},closed=0
    const socket={port:1,remotePort:2,read:()=>new Promise<any>(resolve=>{finishRead=resolve}),async write(_bytes:Uint8Array){},async end(){},async close(){closed++;finishRead({type:'end'})}}
    const client=new WorkerHTTP({connect:async()=>socket},1234,{requestTimeoutMs:20})
    await expect(client.fetch(new Request('https://preview.invalid/'))).rejects.toThrow('HTTP response timed out')
    expect(closed).toBe(1)
  })

  it('preserves the caller abort reason before the response deadline',async()=>{
    let finishRead:(value:any)=>void=()=>{},started!:()=>void,closed=0
    const reading=new Promise<void>(resolve=>{started=resolve})
    const socket={port:1,remotePort:2,read:()=>new Promise<any>(resolve=>{finishRead=resolve;started()}),async write(_bytes:Uint8Array){},async end(){},async close(){closed++;finishRead({type:'end'})}}
    const client=new WorkerHTTP({connect:async()=>socket},1234,{requestTimeoutMs:1000}),controller=new AbortController()
    const request=client.fetch(new Request('https://preview.invalid/',{signal:controller.signal}))
    await reading
    controller.abort(new Error('owner cancelled'))
    await expect(request).rejects.toThrow('owner cancelled')
    expect(closed).toBe(1)
  })
})
