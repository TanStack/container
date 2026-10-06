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
      queueMicrotask(()=>this.onmessage?.({data:{id:message.id,ok:true,
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

it('readiness progress records actual request boundaries and does not change requests or timeouts',async()=>{
  const dev=await server(3000)
  let complete!:(response:Response)=>void,request:Request|undefined
  const phases=()=>dev.progress.map(row=>row.phase)
  vi.spyOn(dev,'previewServer').mockImplementation(()=>({fetch:(input:Request)=>{
    request=input
    return new Promise<Response>(resolve=>{complete=resolve})
  }}))
  const listener=vi.fn(()=>{throw Error('observer failure')})
  const unsubscribe=dev.subscribeEvents(listener)
  try{
    const ready=dev.waitForHTTPReady({timeoutMs:30000})
    await vi.waitFor(()=>expect(request).toBeDefined())
    expect(phases()).toEqual(['host-start-response-received','http-readiness-started','http-readiness-probe-started'])
    expect(request!.url).toBe('http://127.0.0.1:3000/')
    expect(request!.headers.get('accept')).toBe('text/html')
    expect(request!.signal.aborted).toBe(false)
    complete(new Response('ready'))
    expect(await ready).toBe(3000)
    expect(phases()).toEqual(['host-start-response-received','http-readiness-started','http-readiness-probe-started',
      'http-readiness-headers-received','http-readiness-completed'])
    expect(dev.progress.every(row=>Number.isFinite(row.elapsedMs)&&row.elapsedMs>=0)).toBe(true)
    expect(dev.previewServer).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(4)
    expect(dev.events.find(event=>event.type==='progress'&&event.phase==='http-readiness-completed')).toMatchObject({durationMs:expect.any(Number)})
  }finally{unsubscribe();dev.close();vi.unstubAllGlobals()}
})

it('readiness retry progress keeps a failed probe separate from successful readiness',async()=>{
  vi.useFakeTimers()
  const dev=await server(3000)
  let calls=0
  vi.spyOn(dev,'previewServer').mockImplementation(()=>({fetch:async()=>{
    if(++calls===1)throw Error('original probe failure')
    return new Response('ready')
  }}))
  try{
    const ready=dev.waitForHTTPReady()
    await vi.advanceTimersByTimeAsync(251)
    expect(await ready).toBe(3000)
    expect(calls).toBe(2)
    expect(dev.progress.map(row=>row.phase)).toEqual(['host-start-response-received','http-readiness-started',
      'http-readiness-probe-started','http-readiness-probe-failed','http-readiness-probe-started',
      'http-readiness-headers-received','http-readiness-completed'])
  }finally{dev.close();vi.useRealTimers();vi.unstubAllGlobals()}
})
