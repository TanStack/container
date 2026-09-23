import {describe,expect,it,vi} from 'vitest'
import {HOST_OPERATIONS} from '../src/sdk/host-protocol'
import {KernelClient} from '../src/sdk/kernel-client'

const connected=async(options:{expectedBuildId?:string}={})=>{
  const channel=new MessageChannel(),client=new KernelClient(channel.port1,{nonce:'nonce',handshakeTimeoutMs:100,...options})
  channel.port2.start();channel.port2.postMessage({type:'attached',protocolVersion:1,nonce:'nonce',capabilities:{protocolVersion:1,buildId:'build-1',apiVersion:5,crossOriginIsolated:true,sharedArrayBuffer:true,indexedDB:true,operations:HOST_OPERATIONS}})
  await client.ready
  return {client,host:channel.port2}
}

describe('KernelClient',()=>{
  it('performs the handshake and typed request/result exchange',async()=>{
    const {client,host}=await connected({expectedBuildId:'build-1'})
    host.onmessage=event=>host.postMessage({type:'result',id:event.data.id,value:'hello'})
    await expect(client.request('kernel.readFile',['/hello','utf8'])).resolves.toBe('hello')
    client.disconnect()
  })
  it('routes request output and restores remote error details',async()=>{
    const {client,host}=await connected(),output=vi.fn()
    host.onmessage=event=>{host.postMessage({type:'output',requestId:event.data.id,level:'log',text:'one'});host.postMessage({type:'error',id:event.data.id,error:{name:'RangeError',message:'bad range',code:'ERANGE'}})}
    const error=await client.request('kernel.execute',['',{}],{onOutput:output}).catch(value=>value)
    expect(output).toHaveBeenCalledWith('log','one');expect(error).toMatchObject({name:'RangeError',message:'bad range',code:'ERANGE'})
    client.disconnect()
  })
  it('cancels an operation by request id without disconnecting the transport',async()=>{
    const {client,host}=await connected(),messages:any[]=[]
    host.onmessage=event=>messages.push(event.data)
    const controller=new AbortController(),pending=client.request('kernel.install',[{}],{signal:controller.signal})
    await new Promise(resolve=>setTimeout(resolve,0));controller.abort()
    await expect(pending).rejects.toMatchObject({name:'AbortError'})
    await new Promise(resolve=>setTimeout(resolve,0))
    expect(messages[1]).toEqual({type:'cancel',requestId:messages[0].id})
    client.disconnect()
  })
  it('bounds a stalled host request and leaves the transport usable',async()=>{
    const {client,host}=await connected(),messages:any[]=[]
    host.onmessage=event=>{messages.push(event.data);if(event.data.operation==='kernel.resources'&&messages.length>2)host.postMessage({type:'result',id:event.data.id,value:{ok:true}})}
    await expect(client.request('preview.inspect',[],{timeoutMs:10})).rejects.toThrow('preview.inspect (10ms)')
    await new Promise(resolve=>setTimeout(resolve,0))
    expect(messages[1]).toEqual({type:'cancel',requestId:messages[0].id})
    await expect(client.request('kernel.resources',[],{timeoutMs:50})).resolves.toEqual({ok:true})
    client.disconnect()
  })
  it('tracks ports, replays opens and isolates observer failures',async()=>{
    const {client,host}=await connected(),events:string[]=[]
    client.subscribePorts(event=>{events.push(`${event.type}:${event.port}`);throw Error('observer')})
    host.postMessage({type:'port',event:{type:'open',port:4173}});await new Promise(resolve=>setTimeout(resolve,0))
    client.subscribePorts(event=>events.push(`replay:${event.port}`))
    host.postMessage({type:'port',event:{type:'close',port:4173}});await new Promise(resolve=>setTimeout(resolve,0))
    expect(events).toEqual(['open:4173','replay:4173','close:4173','replay:4173'])
    client.disconnect()
  })
  it('rejects mismatched builds and malformed messages',async()=>{
    const channel=new MessageChannel(),client=new KernelClient(channel.port1,{nonce:'nonce',expectedBuildId:'wanted',handshakeTimeoutMs:100})
    channel.port2.postMessage({type:'attached',protocolVersion:1,nonce:'nonce',capabilities:{protocolVersion:1,buildId:'other',apiVersion:5,crossOriginIsolated:true,sharedArrayBuffer:true,indexedDB:true,operations:HOST_OPERATIONS}})
    await expect(client.ready).rejects.toThrow('build mismatch')
    expect(client.closed).toBe(true)
    const second=await connected();second.host.postMessage({type:'result',id:0,value:null});await new Promise(resolve=>setTimeout(resolve,0));expect(second.client.closed).toBe(true)
  })
  it('rejects pending calls and emits synthetic closes on disconnect',async()=>{
    const {client,host}=await connected(),events:string[]=[]
    client.subscribePorts(event=>events.push(`${event.type}:${event.port}`));host.postMessage({type:'port',event:{type:'open',port:3000}});await new Promise(resolve=>setTimeout(resolve,0))
    const pending=client.request('kernel.resources',[]);await new Promise(resolve=>setTimeout(resolve,0));client.disconnect(Error('gone'))
    await expect(pending).rejects.toThrow('gone');expect(events).toEqual(['open:3000','close:3000'])
  })
})
