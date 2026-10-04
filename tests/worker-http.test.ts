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
  for(const rejectClose of [false,true])it(`recovers capacity after failed-request cleanup acknowledgement (${rejectClose})`,async()=>{
    const reason=Error('Write failed'),cancelled=Error('Queued request cancelled')
    const cleanup:Array<{resolve:()=>void;reject:(reason:Error)=>void}>=[]
    let connections=0,activeClosed=0
    const kernel={connect:async()=>{
      if(++connections>32){const active=transport('HTTP/1.1 204 Empty\r\n\r\n');active.socket.close=async()=>{activeClosed++};return active.socket}
      return {port:1,remotePort:2,async read(){return null},async write(_bytes:Uint8Array){throw reason},async end(){},close(){return new Promise<void>((resolve,reject)=>cleanup.push({resolve,reject}))}}
    }}
    const client=new WorkerHTTP(kernel,1234)
    const failures=await Promise.all(Array.from({length:32},()=>client.fetch(new Request('https://preview.invalid/')).catch(error=>error)))
    expect(failures).toEqual(Array(32).fill(reason));expect(cleanup.length).toBe(32)
    const controller=new AbortController()
    const queued=client.fetch(new Request('https://preview.invalid/',{signal:controller.signal})).catch(error=>error)
    let completed=false
    const survivor=client.fetch(new Request('https://preview.invalid/')).then(response=>{completed=true;return response})
    await new Promise(resolve=>setTimeout(resolve,0))
    expect(connections).toBe(32);expect(completed).toBe(false)
    controller.abort(cancelled);expect(await queued).toBe(cancelled)
    if(rejectClose)cleanup[0].reject(Error('Close failed'));else cleanup[0].resolve()
    expect((await survivor).status).toBe(204)
    expect(connections).toBe(33);expect(activeClosed).toBe(1)
    for(const pending of cleanup.slice(1))pending.resolve()
  },1000)
  for(const phase of ['write','headers','body'] as const)it(`reports ${phase} failure without waiting for close acknowledgement`,async()=>{
    const reason=Error('Write failed')
    const peer=transport(phase==='body'?'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nx':'invalid\r\n\r\n')
    let closed=0
    peer.socket.close=()=>{closed++;return new Promise<void>(()=>{})}
    if(phase==='write')peer.socket.write=async()=>{throw reason}
    const client=new WorkerHTTP({connect:async()=>peer.socket},1234)
    if(phase==='write')await expect(client.fetch(new Request('https://preview.invalid/'))).rejects.toBe(reason)
    else if(phase==='headers')await expect(client.fetch(new Request('https://preview.invalid/'))).rejects.toThrow('Invalid HTTP status')
    else{
      const response=await client.fetch(new Request('https://preview.invalid/'))
      await expect(response.text()).rejects.toThrow('Truncated HTTP body')
    }
    expect(closed).toBe(1)
  },1000)
  for(const bodyPhase of [false,true])it(`aborts a stalled response read without waiting for close acknowledgement (${bodyPhase})`,async()=>{
    let start!:()=>void,reads=0,closed=0
    const reading=new Promise<void>(resolve=>{start=resolve})
    const socket={port:1,remotePort:2,read(){
      if(bodyPhase&&reads++===0)return Promise.resolve({type:'data' as const,bytes:new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n')})
      start();return new Promise<any>(()=>{})
    },async write(_bytes:Uint8Array){},async end(){},close(){closed++;return new Promise<void>(()=>{})}}
    const controller=new AbortController(),reason=Error('Response cancelled')
    const client=new WorkerHTTP({connect:async()=>socket},1234)
    const request=client.fetch(new Request('https://preview.invalid/',{signal:controller.signal}))
    const failure=bodyPhase?(await request).text().catch(error=>error):request.catch(error=>error)
    await reading;controller.abort(reason)
    expect(await failure).toBe(reason)
    expect(closed).toBe(1)
  },1000)
  it('releases HTTP capacity before cancelled connections finish',async()=>{
    let started!:()=>void
    const connecting=new Promise<void>(resolve=>{started=resolve})
    const pending:Array<(socket:ReturnType<typeof transport>['socket'])=>void>=[]
    const active=transport('HTTP/1.1 204 No Content\r\n\r\n')
    const kernel={connect:()=>{
      if(pending.length===32)return Promise.resolve(active.socket)
      return new Promise<ReturnType<typeof transport>['socket']>(resolve=>{pending.push(resolve);if(pending.length===32)started()})
    }}
    const client=new WorkerHTTP(kernel,1234),controller=new AbortController(),reason=Error('Owner closed')
    const failures=Array.from({length:32},()=>client.fetch(new Request('https://preview.invalid/',{signal:controller.signal})).catch(error=>error))
    await connecting;controller.abort(reason)
    expect(await Promise.all(failures)).toEqual(Array(32).fill(reason))
    const response=await client.fetch(new Request('https://preview.invalid/'))
    expect(response.status).toBe(204)
    await response.text()
    const late=pending.map(resolve=>{const peer=transport('');resolve(peer.socket);return peer})
    await new Promise(resolve=>setTimeout(resolve,0))
    expect(late.map(peer=>peer.closed)).toEqual(Array(32).fill(1))
    expect(active.closed).toBe(1)
  },1000)
  for(const lateReject of [false,true])it(`aborts a pending connection and cleans up its late result (${lateReject})`,async()=>{
    let started!:()=>void,resolveConnect!:(socket:ReturnType<typeof transport>['socket'])=>void,rejectConnect!:(error:Error)=>void
    const connecting=new Promise<void>(resolve=>{started=resolve})
    const peer=transport('HTTP/1.1 204 No Content\r\n\r\n')
    let writes=0
    peer.socket.write=async()=>{writes++}
    const client=new WorkerHTTP({connect:()=>{started();return new Promise((resolve,reject)=>{resolveConnect=resolve;rejectConnect=reject})}},1234)
    const controller=new AbortController(),reason=Error('Connection cancelled')
    const failure=client.fetch(new Request('https://preview.invalid/',{signal:controller.signal})).catch(error=>error)
    await connecting;controller.abort(reason)
    expect(await failure).toBe(reason)
    if(lateReject)rejectConnect(Error('Late connection failure'));else resolveConnect(peer.socket)
    await new Promise(resolve=>setTimeout(resolve,0))
    expect(peer.closed).toBe(lateReject?0:1)
    expect(writes).toBe(0)
  },1000)
  for(const stalledCancel of [false,true])it(`aborts a stalled request body before opening a socket (${stalledCancel})`,async()=>{
    let started!:()=>void,cancelReason:unknown,connections=0
    const reading=new Promise<void>(resolve=>{started=resolve})
    const body=new ReadableStream<Uint8Array>({
      pull(){started();return new Promise<void>(()=>{})},
      cancel(reason){cancelReason=reason;if(stalledCancel)return new Promise<void>(()=>{})},
    },{highWaterMark:0})
    const controller=new AbortController(),reason=Error('Upload cancelled')
    const request=new Request('https://preview.invalid/',{method:'POST',body,duplex:'half',signal:controller.signal} as RequestInit)
    const client=new WorkerHTTP({connect:async()=>{connections++;return transport('').socket}},1234)
    const failure=client.fetch(request).catch(error=>error)
    await reading;controller.abort(reason)
    expect(await failure).toBe(reason)
    expect(cancelReason).toBe(reason)
    expect(request.body!.locked).toBe(false)
    expect(connections).toBe(0)
  },1000)
  for(const wire of [
    'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok',
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n\r\n',
    'HTTP/1.1 204 No Content\r\n\r\n',
  ])it(`ends successful connections before releasing them (${wire.split('\r\n')[0]})`,async()=>{
    const peer=transport(wire),events:string[]=[]
    peer.socket.end=async()=>{events.push('end')}
    peer.socket.close=async()=>{events.push('close')}
    const client=new WorkerHTTP({connect:async()=>peer.socket},1234)
    const response=await client.fetch(new Request('https://preview.invalid/'))
    await response.text()
    expect(events).toEqual(['end','close'])
  })
  it('cancellation releases the connection without reporting a graceful finish',async()=>{
    const peer=transport('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'),events:string[]=[]
    peer.socket.end=async()=>{events.push('end')}
    peer.socket.close=async()=>{events.push('close')}
    const client=new WorkerHTTP({connect:async()=>peer.socket},1234)
    const response=await client.fetch(new Request('https://preview.invalid/'))
    await response.body!.cancel()
    expect(events).toEqual(['close'])
  })
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
    const failure=await client.fetch(new Request('https://preview.invalid/')).catch(error=>error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).toBe('HTTP response timed out')
    expect(failure.diagnostic).toMatchObject({phase:'response headers',receivedBytes:0,timeoutMs:20})
    expect(failure.diagnostic.writtenBytes).toBeGreaterThan(0)
    expect(closed).toBe(1)
  })

  it('rejects a stalled request write at the same response deadline',async()=>{
    let closed=0
    const socket={port:1,remotePort:2,read:async()=>({type:'end' as const}),write:()=>new Promise<void>(()=>{}),async end(){},async close(){closed++}}
    const client=new WorkerHTTP({connect:async()=>socket},1234,{requestTimeoutMs:20})
    const failure=await client.fetch(new Request('https://preview.invalid/')).catch(error=>error)
    expect(failure.message).toBe('HTTP response timed out')
    expect(failure.diagnostic).toEqual({phase:'request headers',receivedBytes:0,writtenBytes:0,timeoutMs:20})
    expect(closed).toBe(1)
  })

  it('preserves caller abort identity during a stalled request write',async()=>{
    let started!:()=>void,closed=0
    const writing=new Promise<void>(resolve=>{started=resolve})
    const socket={port:1,remotePort:2,read:async()=>({type:'end' as const}),write(){started();return new Promise<void>(()=>{})},async end(){},async close(){closed++}}
    const controller=new AbortController(),reason=Error('Preview closed')
    const client=new WorkerHTTP({connect:async()=>socket},1234,{requestTimeoutMs:1000})
    const pending=client.fetch(new Request('https://preview.invalid/',{signal:controller.signal}))
    const failure=pending.catch(error=>error)
    await writing;controller.abort(reason)
    expect(await failure).toBe(reason)
    expect(closed).toBe(1)
  })

  it('rejects an in-flight response body and closes once when the preview aborts',async()=>{
    let first=true,finishRead:(value:any)=>void=()=>{},started!:()=>void,closed=0
    const reading=new Promise<void>(resolve=>{started=resolve})
    const socket={port:1,remotePort:2,
      async read(){
        if(first){first=false;return {type:'data' as const,bytes:new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n')}}
        return new Promise<any>(resolve=>{finishRead=resolve;started()})
      },
      async write(_bytes:Uint8Array){},async end(){},
      async close(){closed++;finishRead({type:'end'})},
    }
    const controller=new AbortController(),reason=new Error('Preview closed')
    const client=new WorkerHTTP({connect:async()=>socket},1234,{requestTimeoutMs:1000})
    const response=await client.fetch(new Request('https://preview.invalid/',{signal:controller.signal}))
    const body=response.text(),rejected=expect(body).rejects.toBe(reason)
    await reading
    controller.abort(reason)
    await rejected
    expect(closed).toBe(1)
    expect(response.bodyUsed).toBe(true)
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
