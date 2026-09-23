import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {describe,it,expect,vi} from 'vitest'

function serviceWorker(response?:{status:number;headers:[string,string][];body:ArrayBuffer}|Error){
  const listeners=new Map<string,(event:any)=>void>(),cancelled:any[]=[]
  const channels:MessageChannel[]=[],signals:AbortSignal[]=[]
  let workspaceClients:{id:string;url:string}[]=[]
  let posted=false
  const bridge={url:'https://preview.invalid/__sandbox/bridge.html',postMessage(_message:any,_transfer:MessagePort[]){
    posted=true
    if(response instanceof Error)throw response
    const port=_transfer[0]
    port.onmessage=event=>cancelled.push(event.data)
    if(response)port.postMessage(response,[response.body])
  }}
  const self:any={
    location:{origin:'https://preview.invalid'},
    SANDBOX_REQUEST_TIMEOUT_MS:10_000,
    clients:{claim:vi.fn(),get:vi.fn(async()=>({url:'https://preview.invalid/app'})),matchAll:vi.fn(async()=>[bridge,...workspaceClients])},
    addEventListener:(type:string,listener:(event:any)=>void)=>listeners.set(type,listener),
  }
  runInNewContext(readFileSync('preview-host/sw.js','utf8'),{
    URL,Headers,Response,MessageChannel:class {
      constructor(){
        const channel=new MessageChannel()
        vi.spyOn(channel.port1,'close')
        vi.spyOn(channel.port2,'close')
        channels.push(channel)
        return channel
      }
    },setTimeout,clearTimeout,importScripts:()=>{},self,
  })
  return {cancelled,channels,signals,fetch:listeners.get('fetch')!,setWorkspaceClients(value:{id:string;url:string}[]){workspaceClients=value},get posted(){return posted}}
}

function dispatch(worker:ReturnType<typeof serviceWorker>,controller:AbortController,options:{clientId?:string;resultingClientId?:string;mode?:string;keepalive?:boolean}={}){
  let response!:Promise<Response>
  const request=new Request('https://preview.invalid/client.tsx',{signal:controller.signal})
  if(options.mode)Object.defineProperty(request,'mode',{value:options.mode})
  if(options.keepalive)Object.defineProperty(request,'keepalive',{value:true})
  vi.spyOn(request.signal,'addEventListener')
  vi.spyOn(request.signal,'removeEventListener')
  worker.signals.push(request.signal)
  worker.fetch({
    request,
    clientId:options.clientId??'app',resultingClientId:options.resultingClientId??'',respondWith(value:Promise<Response>){response=value},
  })
  return response
}

function expectAbortListenerRemoved(worker:ReturnType<typeof serviceWorker>){
  const signal=worker.signals[0]
  const registered=vi.mocked(signal.addEventListener).mock.calls.find(call=>call[0]==='abort')
  expect(registered).toBeDefined()
  expect(signal.removeEventListener).toHaveBeenCalledWith('abort',registered![1])
}

describe('preview service worker request cancellation',()=>{
  it('forwards browser request cancellation to the owner exactly once',async()=>{
    const worker=serviceWorker(),controller=new AbortController(),response=dispatch(worker,controller)
    await vi.waitFor(()=>expect(worker.posted).toBe(true))
    controller.abort(Error('document navigated'))
    await expect(response).resolves.toMatchObject({status:502})
    await vi.waitFor(()=>expect(worker.cancelled).toEqual([{type:'cancel'}]))
    expectAbortListenerRemoved(worker)
    controller.abort(Error('duplicate abort'))
    expect(worker.cancelled).toEqual([{type:'cancel'}])
  })

  it('removes the abort listener after a completed response',async()=>{
    const body=new TextEncoder().encode('ok').buffer
    const worker=serviceWorker({status:200,headers:[['content-type','text/plain']],body}),controller=new AbortController()
    const response=await dispatch(worker,controller)
    expect(await response.text()).toBe('ok')
    expectAbortListenerRemoved(worker)
    expect(worker.channels[0].port1.close).toHaveBeenCalledTimes(1)
    controller.abort(Error('late abort'))
    await new Promise(resolve=>setTimeout(resolve,0))
    expect(worker.cancelled).toEqual([])
  })

  it('cleans up when the bridge disappears during dispatch',async()=>{
    const worker=serviceWorker(Error('bridge disappeared')),controller=new AbortController()
    const response=await dispatch(worker,controller)
    expect(response.status).toBe(502)
    expect(await response.text()).toContain('bridge disappeared')
    expectAbortListenerRemoved(worker)
    expect(worker.channels[0].port1.close).toHaveBeenCalledTimes(1)
    expect(worker.channels[0].port2.close).toHaveBeenCalledTimes(1)
    controller.abort(Error('late abort'))
    await new Promise(resolve=>setTimeout(resolve,0))
    expect(worker.cancelled).toEqual([])
  })

  it('never dispatches an already aborted request',async()=>{
    const worker=serviceWorker(),controller=new AbortController()
    controller.abort(Error('already navigated'))
    const response=await dispatch(worker,controller)
    expect(response.status).toBe(502)
    expect(worker.posted).toBe(false)
    expectAbortListenerRemoved(worker)
    expect(worker.channels[0].port2.close).toHaveBeenCalledTimes(1)
  })

  it('cancels an old request only after the owning document is demonstrably gone',async()=>{
    const worker=serviceWorker(),moduleController=new AbortController()
    const moduleResponse=dispatch(worker,moduleController,{clientId:'old-document'})
    await vi.waitFor(()=>expect(worker.posted).toBe(true))
    worker.setWorkspaceClients([{id:'old-document',url:'https://preview.invalid/app'}])
    const navigationController=new AbortController()
    const navigationResponse=dispatch(worker,navigationController,{clientId:'',resultingClientId:'new-document',mode:'navigate'})
    await new Promise(resolve=>setTimeout(resolve,25))
    expect(worker.cancelled).toEqual([])
    worker.setWorkspaceClients([{id:'new-document',url:'https://preview.invalid/app'}])
    const assetController=new AbortController()
    const assetResponse=dispatch(worker,assetController,{clientId:'new-document'})
    await expect(moduleResponse).resolves.toMatchObject({status:502})
    await vi.waitFor(()=>expect(worker.cancelled).toContainEqual({type:'cancel'}))
    navigationController.abort(Error('test cleanup'))
    assetController.abort(Error('test cleanup'))
    await Promise.all([navigationResponse,assetResponse])
  })

  it('preserves a live first tab when a second tab navigates and requests assets',async()=>{
    const worker=serviceWorker(),moduleController=new AbortController()
    const moduleResponse=dispatch(worker,moduleController,{clientId:'first-document'})
    await vi.waitFor(()=>expect(worker.posted).toBe(true))
    worker.setWorkspaceClients([
      {id:'first-document',url:'https://preview.invalid/app'},
      {id:'other-tab',url:'https://preview.invalid/other'},
    ])
    const navigationController=new AbortController()
    const navigationResponse=dispatch(worker,navigationController,{clientId:'',resultingClientId:'second-document',mode:'navigate'})
    worker.setWorkspaceClients([
      {id:'first-document',url:'https://preview.invalid/app'},
      {id:'second-document',url:'https://preview.invalid/other'},
    ])
    const assetController=new AbortController()
    const assetResponse=dispatch(worker,assetController,{clientId:'second-document'})
    await new Promise(resolve=>setTimeout(resolve,25))
    expect(worker.cancelled).toEqual([])
    moduleController.abort(Error('test cleanup'))
    navigationController.abort(Error('test cleanup'))
    assetController.abort(Error('test cleanup'))
    await Promise.all([moduleResponse,navigationResponse,assetResponse])
  })

  it('does not lifecycle-cancel a keepalive request after its document closes',async()=>{
    const worker=serviceWorker(),keepaliveController=new AbortController()
    const keepaliveResponse=dispatch(worker,keepaliveController,{clientId:'closed-document',keepalive:true})
    await vi.waitFor(()=>expect(worker.posted).toBe(true))
    worker.setWorkspaceClients([{id:'new-document',url:'https://preview.invalid/app'}])
    const assetController=new AbortController()
    const assetResponse=dispatch(worker,assetController,{clientId:'new-document'})
    await new Promise(resolve=>setTimeout(resolve,25))
    expect(worker.cancelled).toEqual([])
    keepaliveController.abort(Error('explicit cleanup'))
    assetController.abort(Error('explicit cleanup'))
    await Promise.all([keepaliveResponse,assetResponse])
  })

  it('does not lifecycle-track a provisional navigation client',async()=>{
    const worker=serviceWorker(),navigationController=new AbortController()
    const navigationResponse=dispatch(worker,navigationController,{clientId:'',resultingClientId:'provisional-document',mode:'navigate'})
    await vi.waitFor(()=>expect(worker.posted).toBe(true))
    worker.setWorkspaceClients([
      {id:'first-tab',url:'https://preview.invalid/app'},
      {id:'second-tab',url:'https://preview.invalid/other'},
    ])
    const assetController=new AbortController()
    const assetResponse=dispatch(worker,assetController,{clientId:'second-tab'})
    await new Promise(resolve=>setTimeout(resolve,25))
    expect(worker.cancelled).toEqual([])
    navigationController.abort(Error('explicit cleanup'))
    assetController.abort(Error('explicit cleanup'))
    await Promise.all([navigationResponse,assetResponse])
  })
})
