import {expect,it,vi} from 'vitest'
import {NativeDevServer} from '../src/native/dev-server'

async function server(primary:number){
  let raw:any
  vi.stubGlobal('location',{href:'https://sandbox.test/',origin:'https://sandbox.test'})
  vi.stubGlobal('Worker',class{
    onmessage:any;onerror:any;onmessageerror:any
    constructor(){raw=this}
    terminate(){}
    postMessage(message:any){
      queueMicrotask(()=>this.onmessage({data:{id:message.id,ok:true,
        value:{port:primary,webSocketToken:'token'}}}))
    }
  })
  const dev=new NativeDevServer({}, {workerURL:'https://sandbox.test/engine.js'})
  raw.onmessage({data:{type:'native-dev-ready'}})
  await dev.ready
  vi.spyOn(dev,'ports').mockResolvedValue([4000,3000])
  return dev
}

it('does not replace a starting main server with an internal HTTP service',async()=>{
  vi.useFakeTimers()
  const dev=await server(3000)
  const requests:number[]=[]
  vi.spyOn(dev,'previewServer').mockImplementation(port=>({fetch:async()=>{
    requests.push(port)
    return new Response('',{status:port===4000?404:requests.length===1?503:200})
  }}))
  try{
    const ready=dev.waitForHTTPReady()
    await vi.advanceTimersByTimeAsync(251)
    expect(await ready).toBe(3000)
    expect(requests).toEqual([3000,3000])
  }finally{dev.close();vi.useRealTimers();vi.unstubAllGlobals()}
})

it('still discovers a port when the entry does not declare a main service',async()=>{
  const dev=await server(0)
  vi.spyOn(dev,'previewServer').mockImplementation(()=>({fetch:async()=>new Response('ready')}))
  try{expect(await dev.waitForHTTPReady()).toBe(4000)}
  finally{dev.close();vi.unstubAllGlobals()}
})

it('an explicit preview port overrides the declared main port',async()=>{
  const dev=await server(3000)
  const requests:number[]=[]
  vi.spyOn(dev,'previewServer').mockImplementation(port=>({fetch:async()=>{
    requests.push(port);return new Response('ready')
  }}))
  try{
    expect(await dev.waitForHTTPReady({port:4000})).toBe(4000)
    expect(requests).toEqual([4000])
  }finally{dev.close();vi.unstubAllGlobals()}
})
