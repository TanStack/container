import {beforeEach,expect,test,vi} from 'vitest'
import {WorkerHTTP} from '../src/sandbox/worker-http'

const state=vi.hoisted(()=>({fetch:vi.fn()}))
vi.mock('../src/native/dev-server',()=>({NativeDevServer:class{
  subscribeEvents(){return ()=>{}}
  async waitForHTTPReady(){return 3000}
  async dispose(){}
  fetch=state.fetch
}}))
import {installNativeOwnerHost,NativeOwnerClient} from '../src/native/owner-transport'

beforeEach(()=>{state.fetch.mockReset()})
async function owner(){
  let connect!:(event:any)=>void
  const parent={}
  vi.stubGlobal('location',new URL('http://owner.test/'));vi.stubGlobal('parent',parent)
  vi.stubGlobal('addEventListener',(_name:string,listener:any)=>{connect=listener})
  vi.stubGlobal('removeEventListener',vi.fn())
  const cleanup=installNativeOwnerHost({allowedParentOrigin:'http://app.test',workerURL:'/engine.js'})
  vi.stubGlobal('location',new URL('http://app.test/'))
  const frame={postMessage(data:unknown,_origin:string,ports:MessagePort[]){
    connect({origin:'http://app.test',source:parent,data,ports})
  }}
  const client=await NativeOwnerClient.connect(frame as unknown as Window,'http://owner.test')
  await client.start({})
  return {client,async close(){client.close();await cleanup();vi.unstubAllGlobals()}}
}

test('owner cancellation before headers preserves the reason and aborts the HTTP request',async()=>{
  let signal:AbortSignal|undefined
  state.fetch.mockImplementation((request:Request)=>new Promise((_resolve,reject)=>{
    signal=request.signal
    request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true})
  }))
  const fixture=await owner(),controller=new AbortController(),reason=Error('Document replaced')
  try{
    const failed=fixture.client.fetch(new Request('http://preview.test/slow.js',{signal:controller.signal})).catch(error=>error)
    await vi.waitFor(()=>expect(signal).toBeDefined())
    controller.abort(reason)
    await vi.waitFor(()=>expect(signal?.aborted).toBe(true))
    expect(await failed).toBe(reason)
  }finally{await fixture.close()}
})

test('owner cancellation interrupts a pending body read without awaiting source cleanup',async()=>{
  const cancelled=vi.fn(()=>new Promise<void>(()=>{}))
  state.fetch.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({cancel:cancelled},{highWaterMark:0})))
  const fixture=await owner(),controller=new AbortController(),reason=Error('Body replaced')
  try{
    const response=await fixture.client.fetch(new Request('http://preview.test/body',{signal:controller.signal}))
    const failed=response.text().catch(error=>error)
    controller.abort(reason)
    await vi.waitFor(()=>expect(cancelled).toHaveBeenCalledOnce())
    expect(await failed).toBe(reason)
    expect(await fixture.client.resources()).toMatchObject({responseStreams:0})
  }finally{await fixture.close()}
})

test('a replacement document can fetch after all 32 old HTTP slots are cancelled before headers',async()=>{
  let waiting=0,closed=0,healthy=false
  const http=new WorkerHTTP({connect:async()=>({
    async write(){},async end(){},async close(){closed++},
    read(){
      if(healthy)return Promise.resolve({type:'data' as const,bytes:new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')})
      waiting++;return new Promise<never>(()=>{})
    },
  })},3000)
  state.fetch.mockImplementation((request:Request)=>http.fetch(request))
  const fixture=await owner()
  const controllers=Array.from({length:32},()=>new AbortController())
  const pending=controllers.map((controller,index)=>fixture.client.fetch(
    new Request('http://preview.test/old-'+index,{signal:controller.signal}),
  ).catch(error=>error))
  try{
    await vi.waitFor(()=>expect(waiting).toBe(32))
    for(const controller of controllers)controller.abort(Error('Old document gone'))
    await vi.waitFor(()=>expect(closed).toBe(32))
    expect((await Promise.all(pending)).every(error=>error.message==='Old document gone')).toBe(true)
    // Keep the same kernel and capacity pool for the replacement document.
    healthy=true
    expect(await(await fixture.client.fetch(new Request('http://preview.test/new'))).text()).toBe('ok')
  }finally{await fixture.close();await Promise.all(pending)}
})

test('a pre-aborted request never reaches the owner',async()=>{
  const fixture=await owner(),controller=new AbortController(),reason=Error('Already cancelled')
  try{
    controller.abort(reason)
    await expect(fixture.client.fetch(new Request('http://preview.test/',{signal:controller.signal}))).rejects.toBe(reason)
    expect(state.fetch).not.toHaveBeenCalled()
  }finally{await fixture.close()}
})

test('upload cancellation closes a pending body reader without calling the owner',async()=>{
  const fixture=await owner(),controller=new AbortController(),reason=Error('Upload cancelled')
  const cancelled=vi.fn(()=>new Promise<void>(()=>{}))
  const request=new Request('http://preview.test/',{
    method:'POST',signal:controller.signal,
    body:new ReadableStream<Uint8Array>({cancel:cancelled},{highWaterMark:0}),
    duplex:'half',
  } as RequestInit)
  try{
    const failed=fixture.client.fetch(request).catch(error=>error)
    controller.abort(reason)
    expect(await failed).toBe(reason)
    expect(cancelled).toHaveBeenCalledOnce()
    expect(state.fetch).not.toHaveBeenCalled()
  }finally{await fixture.close()}
})

test('closing the client rejects a pending body read and releases the owner stream',async()=>{
  const cancelled=vi.fn(()=>new Promise<void>(()=>{}))
  state.fetch.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({cancel:cancelled},{highWaterMark:0})))
  const fixture=await owner()
  try{
    const response=await fixture.client.fetch(new Request('http://preview.test/'))
    const failed=response.text().catch(error=>error)
    fixture.client.close()
    expect(await failed).toMatchObject({message:'Owner channel closed'})
    await vi.waitFor(()=>expect(cancelled).toHaveBeenCalledOnce())
  }finally{await fixture.close()}
})

test('disposing the owner interrupts an active response body',async()=>{
  const cancelled=vi.fn(()=>new Promise<void>(()=>{}))
  state.fetch.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({cancel:cancelled},{highWaterMark:0})))
  const fixture=await owner()
  try{
    const response=await fixture.client.fetch(new Request('http://preview.test/'))
    const failed=response.text().catch(error=>error)
    await fixture.client.dispose()
    expect(await failed).toMatchObject({message:'Error: Owner HTTP request cancelled'})
    expect(cancelled).toHaveBeenCalledOnce()
  }finally{await fixture.close()}
})

test('a late response from a source that ignores cancellation is cleaned up',async()=>{
  let resolve!:(response:Response)=>void
  state.fetch.mockImplementation(()=>new Promise<Response>(done=>{resolve=done}))
  const fixture=await owner(),controller=new AbortController()
  const cancelled=vi.fn()
  try{
    const failed=fixture.client.fetch(new Request('http://preview.test/',{signal:controller.signal})).catch(error=>error)
    await vi.waitFor(()=>expect(resolve).toBeDefined())
    controller.abort(Error('No longer needed'))
    expect(await failed).toMatchObject({message:'No longer needed'})
    // Wait for the cancellation message to cross the owner boundary.
    await vi.waitFor(()=>expect(state.fetch.mock.calls[0]![0].signal.aborted).toBe(true))
    resolve(new Response(new ReadableStream<Uint8Array>({cancel:cancelled},{highWaterMark:0})))
    await vi.waitFor(()=>expect(cancelled).toHaveBeenCalledOnce())
    expect(await fixture.client.resources()).toMatchObject({responseStreams:0})
  }finally{await fixture.close()}
})
