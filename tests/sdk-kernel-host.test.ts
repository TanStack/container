import {describe,expect,it,vi} from 'vitest'
import {bootstrapKernelHost,KernelHostDispatcher,readKernelHostConfiguration} from '../src/sdk/kernel-host'
import {HOST_ATTACH_TYPE,HOST_PROTOCOL_VERSION} from '../src/sdk/host-protocol'
import type {HostOperation,HostServerMessage} from '../src/sdk/host-protocol'

const bytes=new TextEncoder().encode('data')

class FakeKernel {
  assetBaseURL='https://host.test/runtime/'
  listeningPorts=[4173]
  shutdown:Promise<void>|undefined
  portObserver:((event:{type:'open'|'close';port:number})=>void)|undefined
  close=vi.fn(()=>{this.shutdown=Promise.resolve()})
  subscribePorts=vi.fn((observer:(event:{type:'open'|'close';port:number})=>void)=>{this.portObserver=observer;return vi.fn()})
  snapshot=vi.fn(async()=>({version:2,files:{'/a':bytes},directories:['/']}))
  restore=vi.fn(async()=>{})
  saveCheckpoint=vi.fn(async(key:string)=>({key}))
  restoreCheckpoint=vi.fn(async(key:string)=>({key}))
  checkpointMetadata=vi.fn(async(key:string)=>({key}))
  deleteCheckpoint=vi.fn(async()=>true)
  readFile=vi.fn(async()=>bytes)
  readText=vi.fn(async()=> 'data')
  writeFile=vi.fn(async()=>{})
  writeText=vi.fn(async()=>{})
  install=vi.fn(async(_options:unknown,signal:AbortSignal)=>{await new Promise<void>((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});setTimeout(resolve,50)})})
  cancelInstall=vi.fn(async()=>{})
  resources=vi.fn(async()=>({processes:{active:0}}))
  execute=vi.fn(async(_code:string,options:{onOutput:(level:string,text:string)=>void})=>{options.onOutput('log','hello');return {value:1}})
  run=this.execute
  runModule=this.execute
  spawn=vi.fn(async()=>({pid:7,next:vi.fn(async()=>({type:'stdout',bytes})),write:vi.fn(async()=>{}),end:vi.fn(async()=>{}),wait:vi.fn(async()=>({exitCode:0,signal:null})),kill:vi.fn(async()=>true),dispose:vi.fn(async()=>{})}))
  spawnShell=this.spawn
  connect=vi.fn(async()=>({port:51000,remotePort:4173,read:vi.fn(async()=>({type:'data',bytes})),write:vi.fn(async()=>{}),end:vi.fn(async()=>{}),close:vi.fn(async()=>{})}))
  openFileSession=vi.fn(async()=>({call:vi.fn(async()=>['entry']),close:vi.fn(async()=>{})}))
}

const request=(operation:HostOperation,args:unknown[]=[],id=1)=>({type:'request' as const,id,operation,args})

describe('KernelHostDispatcher',()=>{
  it('owns a kernel, forwards output and ports, and exposes opaque resource handles',async()=>{
    const messages:unknown[]=[],kernel=new FakeKernel()
    const host=new KernelHostDispatcher(value=>messages.push(value),(()=>kernel) as never)
    expect(await host.dispatch(request('kernel.create',[{'/a':'data'},{}]),new AbortController().signal)).toBeUndefined()
    kernel.portObserver?.({type:'open',port:3000})
    await expect(host.dispatch(request('kernel.execute',['code',{}],19),new AbortController().signal)).resolves.toEqual({value:1})
    const process=await host.dispatch(request('kernel.spawn',['node',['app.js'],{}]),new AbortController().signal) as {handle:number;pid:number}
    const shell=await host.dispatch(request('kernel.spawnShell',['node app.js',{}]),new AbortController().signal) as {handle:number;pid:number}
    const socket=await host.dispatch(request('kernel.connect',[4173]),new AbortController().signal) as {handle:number}
    const file=await host.dispatch(request('kernel.openFileSession',[true]),new AbortController().signal) as {handle:number}
    expect(process).toEqual({handle:1,pid:7});expect(shell).toEqual({handle:2,pid:7})
    expect(socket.handle).toBe(3);expect(file.handle).toBe(4)
    await expect(host.dispatch(request('process.next',[process.handle]),new AbortController().signal)).resolves.toEqual({type:'stdout',bytes})
    await expect(host.dispatch(request('socket.read',[socket.handle]),new AbortController().signal)).resolves.toEqual({type:'data',bytes})
    await expect(host.dispatch(request('file.call',[file.handle,'readdir',['/']]),new AbortController().signal)).resolves.toEqual(['entry'])
    expect(messages).toEqual([
      {type:'port',event:{type:'open',port:3000}},
      {type:'output',requestId:19,level:'log',text:'hello'},
    ])
  })

  it('rejects duplicate creation, unknown operations and forged handles',async()=>{
    const kernel=new FakeKernel(),host=new KernelHostDispatcher(()=>{},(()=>kernel) as never),signal=new AbortController().signal
    await host.dispatch(request('kernel.create'),signal)
    await expect(host.dispatch(request('kernel.create'),signal)).rejects.toThrow('Kernel already created')
    await expect(host.dispatch(request('process.wait',[99]),signal)).rejects.toThrow('Unknown process handle')
    await expect(host.dispatch(request('other.operation' as HostOperation),signal)).rejects.toThrow('Unsupported host operation')
  })

  it('rejects hosted preview deadlines outside the public bounded range before touching the document',async()=>{
    const kernel=new FakeKernel(),host=new KernelHostDispatcher(()=>{},(()=>kernel) as never),signal=new AbortController().signal
    await host.dispatch(request('kernel.create'),signal)
    for(const value of [NaN,0,10.5,120001]){
      await expect(host.dispatch(request('kernel.mountPreview',[{origin:'https://preview.test',port:4173,requestTimeoutMs:value}]),signal)).rejects.toThrow('requestTimeoutMs')
      await expect(host.dispatch(request('kernel.mountPreview',[{origin:'https://preview.test',port:4173,startupTimeoutMs:value}]),signal)).rejects.toThrow('startupTimeoutMs')
    }
  })

  it('passes cancellation to installation and cooperatively disposes every owned handle',async()=>{
    const kernel=new FakeKernel(),host=new KernelHostDispatcher(()=>{},(()=>kernel) as never),signal=new AbortController()
    await host.dispatch(request('kernel.create'),signal.signal)
    const process=await host.dispatch(request('kernel.spawn',['node']),signal.signal) as {handle:number}
    const socket=await host.dispatch(request('kernel.connect',[4173,'127.0.0.1']),signal.signal) as {handle:number}
    const file=await host.dispatch(request('kernel.openFileSession',[false]),signal.signal) as {handle:number}
    const install=host.dispatch(request('kernel.install'),signal.signal);signal.abort(Error('cancelled'))
    await expect(install).rejects.toThrow('cancelled')
    await host.close();await host.close()
    const processValue=await kernel.spawn.mock.results[0].value,socketValue=await kernel.connect.mock.results[0].value,fileValue=await kernel.openFileSession.mock.results[0].value
    expect([process.handle,socket.handle,file.handle]).toEqual([1,2,3])
    expect(processValue.dispose).toHaveBeenCalledOnce();expect(socketValue.close).toHaveBeenCalledOnce();expect(fileValue.close).toHaveBeenCalledOnce()
    expect(kernel.close).toHaveBeenCalledOnce()
  })
})

it('requires an exact HTTP owner origin and bounded nonempty nonce',()=>{
  const documentValue={querySelector:()=>({content:'build-1'})} as unknown as Document
  expect(readKernelHostConfiguration(new URL('https://host.test/kernel-host.html?ownerOrigin=https%3A%2F%2Fowner.test&nonce=abc'),documentValue)).toEqual({ownerOrigin:'https://owner.test',nonce:'abc',buildId:'build-1'})
  expect(()=>readKernelHostConfiguration(new URL('https://host.test/?ownerOrigin=https%3A%2F%2Fowner.test%2Fpath&nonce=x'),documentValue)).toThrow('exact HTTP origin')
  expect(()=>readKernelHostConfiguration(new URL('https://host.test/?ownerOrigin=https%3A%2F%2Fowner.test'),documentValue)).toThrow('nonce')
})

it('attaches once only to the configured parent, origin, nonce, protocol, and single port',async()=>{
  const parent={},listeners=new Set<(event:MessageEvent)=>void>()
  const scope={parent,addEventListener:(_type:string,listener:(event:MessageEvent)=>void)=>listeners.add(listener),removeEventListener:(_type:string,listener:(event:MessageEvent)=>void)=>listeners.delete(listener)} as unknown as Window
  bootstrapKernelHost({ownerOrigin:'https://owner.test',nonce:'secret',buildId:'build-2'},scope)
  const dispatch=(data:unknown,origin='https://owner.test',source:unknown=parent,ports:MessagePort[]=[])=>{
    for(const listener of [...listeners])listener({data,origin,source,ports} as unknown as MessageEvent)
  }
  const attach={type:HOST_ATTACH_TYPE,protocolVersion:HOST_PROTOCOL_VERSION,nonce:'secret',ownerOrigin:'https://owner.test'}
  dispatch(attach,'https://attacker.test',parent,[new MessageChannel().port2])
  dispatch({...attach,nonce:'wrong'},'https://owner.test',parent,[new MessageChannel().port2])
  dispatch(attach,'https://owner.test',{},[new MessageChannel().port2])
  dispatch(attach,'https://owner.test',parent,[])
  expect(listeners.size).toBe(1)
  const channel=new MessageChannel(),attached=new Promise<HostServerMessage>(resolve=>channel.port1.onmessage=event=>resolve(event.data))
  dispatch(attach,'https://owner.test',parent,[channel.port2])
  await expect(attached).resolves.toMatchObject({type:'attached',protocolVersion:1,nonce:'secret',capabilities:{protocolVersion:1,buildId:'build-2'}})
  expect(listeners.size).toBe(0)
  channel.port1.close()
})
