import {describe,it,expect,vi} from 'vitest'
import {WorkerHTTP} from '../src/sandbox/worker-http'
import {IncomingRequest} from '../src/sandbox/incoming-request'

// Model a Request implementation with working body consumption methods but no
// public body stream. This is not an assertion about every Firefox version.
class NoBodyStreamRequest extends Request {
  override get body(){return null}
}
class NoBodyStreamIncomingRequest extends IncomingRequest {
  override get body(){return null}
}
const url='https://preview.invalid/submit'
function peer(){
  const writes:Uint8Array[]=[]
  const socket={port:1,remotePort:2,
    async read(){return {type:'data' as const,bytes:new TextEncoder().encode('HTTP/1.1 204 No Content\r\n\r\n')}},
    async write(bytes:Uint8Array){writes.push(bytes.slice())},async end(){},async close(){},
  }
  const connect=vi.fn(async()=>socket)
  return {connect,client:new WorkerHTTP({connect},1234),writes,
    body(){return Buffer.concat(writes.slice(1))},
    headers(){return new TextDecoder().decode(writes[0])},
  }
}

describe('WorkerHTTP requests without an exposed body stream',()=>{
  for(const [name,body,expected] of [
    ['string','increment',Buffer.from('increment')],
    ['binary',new Uint8Array([0,128,255,13,10]),Buffer.from([0,128,255,13,10])],
    ['empty','',Buffer.alloc(0)],
    ['absent',undefined,Buffer.alloc(0)],
  ] as const)it(`forwards ${name} body bytes`,async()=>{
    const p=peer(),request=new NoBodyStreamRequest(url,{method:'POST',body})
    expect(request.body).toBe(null)
    expect((await p.client.fetch(request)).status).toBe(204)
    expect(p.connect).toHaveBeenCalledOnce()
    expect(p.body()).toEqual(expected)
    if(expected.length)expect(p.headers()).toContain(`content-length: ${expected.length}\r\n`)
    else expect(p.headers()).not.toMatch(/content-length: [1-9]/)
  })

  it('preserves IncomingRequest payload and headers after consuming its clone',async()=>{
    const p=peer(),request=new NoBodyStreamIncomingRequest(url,{
      method:'POST',body:'increment',headers:{Origin:'https://owner.invalid',Cookie:'session=test'},
    })
    const clone=request.clone()
    expect(clone.headers.get('cookie')).toBe('session=test')
    expect(await clone.text()).toBe('increment')
    expect(request.bodyUsed).toBe(false)
    await p.client.fetch(request)
    expect(p.body().toString()).toBe('increment')
    expect(p.headers()).toContain('cookie: session=test\r\n')
    expect(p.headers()).toContain('origin: https://owner.invalid\r\n')
  })

  it('rejects a previously consumed body without connecting',async()=>{
    const p=peer(),request=new NoBodyStreamRequest(url,{method:'POST',body:'used'})
    await request.text()
    await expect(p.client.fetch(request)).rejects.toThrow()
    expect(p.connect).not.toHaveBeenCalled()
  })

  it('rejects a locked native body without connecting',async()=>{
    const p=peer(),request=new NoBodyStreamRequest(url,{method:'POST',body:'locked'})
    const nativeBody=Object.getOwnPropertyDescriptor(Request.prototype,'body')!.get!.call(request) as ReadableStream<Uint8Array>
    const reader=nativeBody.getReader()
    try{
      await expect(p.client.fetch(request)).rejects.toThrow()
      expect(p.connect).not.toHaveBeenCalled()
    }finally{reader.releaseLock()}
  })

  it('rejects oversized buffered input before connecting',async()=>{
    const p=peer(),request=new NoBodyStreamRequest(url,{method:'POST',body:new Uint8Array(16*1024*1024+1)})
    await expect(p.client.fetch(request)).rejects.toThrow('16 MiB')
    expect(p.connect).not.toHaveBeenCalled()
  })

  it('rejects an already aborted request before consuming or connecting',async()=>{
    const p=peer(),controller=new AbortController(),reason=new Error('already aborted')
    const request=new NoBodyStreamRequest(url,{method:'POST',body:'unused',signal:controller.signal})
    const consume=vi.spyOn(request,'arrayBuffer')
    controller.abort(reason)
    await expect(p.client.fetch(request)).rejects.toBe(reason)
    expect(consume).not.toHaveBeenCalled()
    expect(p.connect).not.toHaveBeenCalled()
  })

  it('rejects promptly during a pending body read and ignores its later result',async()=>{
    const p=peer(),controller=new AbortController(),reason=new Error('aborted while buffering')
    const request=new NoBodyStreamRequest(url,{method:'POST',body:'pending',signal:controller.signal})
    let resolveBody!:(body:ArrayBuffer)=>void
    const consume=vi.spyOn(request,'arrayBuffer').mockImplementation(()=>new Promise(resolve=>{resolveBody=resolve}))
    const result=p.client.fetch(request)
    const rejected=expect(result).rejects.toBe(reason)
    expect(consume).toHaveBeenCalledOnce()
    controller.abort(reason)
    await rejected
    expect(p.connect).not.toHaveBeenCalled()
    resolveBody(new TextEncoder().encode('pending').buffer)
    await Promise.resolve();await Promise.resolve()
    expect(p.connect).not.toHaveBeenCalled()
  })
})
