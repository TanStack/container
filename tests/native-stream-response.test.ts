import {expect,it} from 'vitest'
import {StreamResponse} from '../src/sandbox/stream-response'

for(const method of ['text','arrayBuffer','json','blob','formData','bytes'] as const){
  it(`preserves the original body error in ${method}`,async()=>{
    const reason=Error('Body cancelled')
    const response=new StreamResponse(new ReadableStream({start(controller){controller.error(reason)}}),{headers:{'content-type':'application/x-www-form-urlencoded'}})
    await expect(response[method]()).rejects.toBe(reason)
    expect(response.bodyUsed).toBe(true)
    await expect(response[method]()).rejects.toBeInstanceOf(TypeError)
  })
}
it('decodes split UTF-8 bytes and clones without consuming either branch',async()=>{
  const bytes=new TextEncoder().encode('hello 🌍')
  const response=new StreamResponse(new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,8));controller.enqueue(bytes.subarray(8));controller.close()}}),{status:201,statusText:'Created',headers:{'x-test':'yes'}})
  const clone=response.clone()
  expect(response.bodyUsed).toBe(false)
  expect(clone).toBeInstanceOf(StreamResponse)
  expect(clone.status).toBe(201);expect(clone.statusText).toBe('Created');expect(clone.headers.get('x-test')).toBe('yes')
  expect(await response.text()).toBe('hello 🌍');expect(await clone.text()).toBe('hello 🌍')
  await expect(response.text()).rejects.toBeInstanceOf(TypeError)
  expect(()=>response.clone()).toThrow(TypeError)
})
it('supports empty bodies, JSON, binary views, blobs and form data',async()=>{
  const empty=new StreamResponse(null,{status:204})
  expect(await empty.text()).toBe('');expect(await empty.text()).toBe('');expect(empty.bodyUsed).toBe(false)
  expect(await new StreamResponse('{"ok":true}').json()).toEqual({ok:true})
  expect([...await new StreamResponse(new Uint8Array([9,1,2,9]).subarray(1,3)).bytes()]).toEqual([1,2])
  const blob=await new StreamResponse('ok',{headers:{'content-type':'text/plain'}}).blob()
  expect(blob.type).toBe('text/plain');expect(await blob.text()).toBe('ok')
  const form=await new StreamResponse('a=hello+world&a=again',{headers:{'content-type':'application/x-www-form-urlencoded'}}).formData()
  expect(form.getAll('a')).toEqual(['hello world','again'])
})
it('rejects locked bodies without consuming their reader',async()=>{
  const response=new StreamResponse('ok'),reader=response.body!.getReader()
  await expect(response.text()).rejects.toBeInstanceOf(TypeError)
  expect(response.bodyUsed).toBe(false)
  reader.releaseLock();expect(await response.text()).toBe('ok')
})
