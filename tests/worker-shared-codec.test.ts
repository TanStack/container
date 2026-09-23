import {readFileSync} from 'node:fs'
import {EventEmitter} from 'node:events'
import {expect,it,vi} from 'vitest'
// @ts-expect-error Guest source has no host declarations.
import {encodeIPC,decodeIPC} from '../src/sandbox/guest-ipc-codec.js'

const portsFactory=new Function(`${readFileSync('src/sandbox/guest-routed-ports.js','utf8')};return createRoutedPorts`)()
const source=readFileSync('src/sandbox/guest-worker-threads.js','utf8')
const preparation=source.slice(source.indexOf('const routedPorts='),source.indexOf('function workerOptions'))
const factory=new Function('host','EventEmitter','createRoutedPorts','encodeIPC','decodeIPC',`
const encoder=new TextEncoder(),decoder=new TextDecoder();
const unsupported=message=>Error(message);
${preparation}
return {prepareMessage,encodeTransferred,value,initialWorkerData,routedPorts};`)
function setup(){
  const buffer=new SharedArrayBuffer(4)
  const host={shared:{retain:vi.fn(()=>7),release:vi.fn(),adopt:vi.fn(()=>buffer),finishWorkerData:vi.fn()},proc:{call:vi.fn((method:string)=>method==='routedPortPair'?[1,2]:undefined)}}
  return {host,buffer,api:factory(host,EventEmitter,portsFactory,encodeIPC,decodeIPC)}
}
it('rolls back retained buffers on serialization and size failures',()=>{
  const {host,buffer,api}=setup()
  expect(()=>api.prepareMessage({buffer,unsupported:()=>{}},[])).toThrow()
  expect(host.shared.release).toHaveBeenLastCalledWith([7])
  expect(()=>api.prepareMessage({buffer,text:'x'.repeat(5*1024*1024)},[])).toThrow('byte limit')
  expect(host.shared.release).toHaveBeenCalledTimes(2)
})
it('commits successful ownership without release and makes rollback idempotent',()=>{
  const {host,buffer,api}=setup(),prepared=api.prepareMessage({buffer,again:buffer},[])
  expect(prepared.shared).toEqual([7]);expect(host.shared.retain).toHaveBeenCalledTimes(1)
  prepared.commit();prepared.rollback();expect(host.shared.release).not.toHaveBeenCalled()
  const failed=api.prepareMessage(buffer,[]);failed.rollback();failed.rollback()
  expect(host.shared.release).toHaveBeenCalledTimes(1)
})
it('authorizes adoption with the current delivery and finishes worker data on failure',()=>{
  const {host,buffer,api}=setup(),prepared=api.prepareMessage(buffer,[])
  expect(api.value(prepared.bytes,{scope:'worker',endpoint:9,token:4})).toBe(buffer)
  expect(host.shared.adopt).toHaveBeenCalledWith('worker',9,4,7)
  Object.assign(host,{worker:{data:prepared.text}})
  expect(api.initialWorkerData()).toBe(buffer)
  expect(host.shared.adopt).toHaveBeenLastCalledWith('data',0,0,7)
  host.shared.adopt.mockImplementation(()=>{throw Error('decode failed')})
  expect(()=>api.initialWorkerData()).toThrow('decode failed')
  expect(host.shared.finishWorkerData).toHaveBeenCalledTimes(2)
})
it('passes provisional IDs to routed sends and releases only on send failure',()=>{
  const {host,buffer,api}=setup(),{port1}=new api.routedPorts.MessageChannel()
  port1.postMessage(buffer)
  expect(host.proc.call).toHaveBeenLastCalledWith('routedPortSend',1,expect.any(Uint8Array),[],[7],[])
  expect(host.shared.release).not.toHaveBeenCalled()
  host.proc.call.mockImplementation((method:string)=>{if(method==='routedPortSend')throw Error('send failed');return undefined})
  expect(()=>port1.postMessage(buffer)).toThrow('send failed')
  expect(host.shared.release).toHaveBeenCalledWith([7])
})

it('retains WASM memory controls once and wraps scoped adoption rather than cloning their fields',()=>{
  const {host,api}=setup(),memory={},handle={},adoptedHandle={},adoptedMemory={}
  const retainMemory=vi.fn(()=>8),wrap=vi.fn(()=>adoptedMemory)
  Object.assign(host.shared,{retainMemory,wasmMemory:{isMemory:(value:unknown)=>value===memory,unwrap:()=>handle,wrap}})
  host.shared.adopt.mockReturnValue(adoptedHandle as SharedArrayBuffer)
  const prepared=api.prepareMessage({memory,again:memory},[])
  expect(retainMemory).toHaveBeenCalledExactlyOnceWith(handle)
  expect(prepared.shared).toEqual([8])
  const result=api.value(prepared.bytes,{scope:'port',endpoint:12,token:3})
  expect(host.shared.adopt).toHaveBeenCalledWith('port',12,3,8)
  expect(wrap).toHaveBeenCalledExactlyOnceWith(adoptedHandle)
  expect(result.memory).toBe(adoptedMemory);expect(result.again).toBe(adoptedMemory)
  prepared.commit();prepared.rollback()
  expect(host.shared.release).not.toHaveBeenCalled()
})

it('rolls back mixed memory and buffer leases when a later field fails serialization',()=>{
  const {host,buffer,api}=setup(),memory={}
  const retainMemory=vi.fn(()=>8)
  Object.assign(host.shared,{retainMemory,wasmMemory:{isMemory:(value:unknown)=>value===memory,unwrap:()=>memory}})
  expect(()=>api.prepareMessage({buffer,memory,invalid:()=>{}},[])).toThrow('serialized')
  expect(host.shared.release).toHaveBeenCalledExactlyOnceWith([7,8])
  retainMemory.mockImplementation(()=>{throw Error('Memory is not shared')})
  expect(()=>api.prepareMessage({buffer,memory},[])).toThrow('not shared')
  expect(host.shared.release).toHaveBeenLastCalledWith([7])
})

function setupModules(){
  const setupResult=setup(),bytes=Uint8Array.from([0,97,115,109,1,0,0,0]).buffer
  const module=new WebAssembly.Module(bytes)
  const handle={},getHandle=vi.fn(()=>handle),getBytes=vi.fn(()=>bytes)
  const moduleResources={retain:vi.fn(()=>11),release:vi.fn(),adopt:vi.fn(()=>bytes)}
  const modules={load:vi.fn()}
  Object.assign(setupResult.host,{modules,moduleResources,wasmModule:{isModule:(value:unknown)=>value instanceof WebAssembly.Module,handle:getHandle,bytes:getBytes,fromBytes:(value:ArrayBuffer)=>new WebAssembly.Module(value)}})
  return {...setupResult,module,moduleResources,modules,bytes,handle,getHandle,getBytes}
}
it('keeps module resources separate from loader API and adopts repeated aliases once',()=>{
  const {api,host,module,moduleResources,modules,handle,getHandle,getBytes,buffer}=setupModules()
  const prepared=api.prepareMessage({module,again:module,buffer},[])
  expect(prepared.modules).toEqual([11]);expect(prepared.shared).toEqual([7])
  expect(moduleResources.retain).toHaveBeenCalledExactlyOnceWith(handle)
  expect(getHandle).toHaveBeenCalledExactlyOnceWith(module);expect(getBytes).not.toHaveBeenCalled()
  const result=api.value(prepared.bytes,{scope:'port',endpoint:12,token:3})
  expect(result.module).toBeInstanceOf(WebAssembly.Module);expect(result.again).toBe(result.module)
  expect(moduleResources.adopt).toHaveBeenCalledExactlyOnceWith('port',12,3,11)
  expect(modules.load).not.toHaveBeenCalled()
  prepared.commit();prepared.rollback()
  expect(moduleResources.release).not.toHaveBeenCalled();expect(host.shared.release).not.toHaveBeenCalled()
})
it('keeps legacy module byte encoding when no module resource bridge exists',()=>{
  const {api,host,module,getHandle,getBytes}=setupModules()
  delete (host as any).moduleResources
  const prepared=api.prepareMessage({module,again:module},[])
  expect(getBytes).toHaveBeenCalledExactlyOnceWith(module);expect(getHandle).not.toHaveBeenCalled()
  expect(prepared.modules).toEqual([])
  const result=api.value(prepared.bytes,{scope:'port',endpoint:12,token:3})
  expect(result.module).toBeInstanceOf(WebAssembly.Module);expect(result.again).toBe(result.module)
})
it('rolls back preceding shared leases when direct module retention rejects',()=>{
  const {api,host,module,moduleResources,buffer,getBytes}=setupModules()
  moduleResources.retain.mockImplementation(()=>{throw Error('Module resource budget exceeded')})
  expect(()=>api.prepareMessage({buffer,module},[])).toThrow('Module resource budget exceeded')
  expect(host.shared.release).toHaveBeenCalledExactlyOnceWith([7])
  expect(moduleResources.release).not.toHaveBeenCalled();expect(getBytes).not.toHaveBeenCalled()
})
it('rolls back mixed module and shared resources on serialization, size, and send failures',()=>{
  const {api,host,module,moduleResources,buffer}=setupModules()
  expect(()=>api.prepareMessage({buffer,module,invalid:()=>{}},[])).toThrow('serialized')
  expect(host.shared.release).toHaveBeenLastCalledWith([7]);expect(moduleResources.release).toHaveBeenLastCalledWith([11])
  expect(()=>api.prepareMessage({buffer,module,text:'x'.repeat(5*1024*1024)},[])).toThrow('byte limit')
  const {port1}=new api.routedPorts.MessageChannel()
  port1.postMessage({buffer,module})
  expect(host.proc.call).toHaveBeenLastCalledWith('routedPortSend',1,expect.any(Uint8Array),[],[7],[11])
  expect(moduleResources.release).toHaveBeenCalledTimes(2)
  host.proc.call.mockImplementation((method:string)=>{if(method==='routedPortSend')throw Error('send failed');return undefined})
  expect(()=>port1.postMessage({buffer,module})).toThrow('send failed')
  expect(moduleResources.release).toHaveBeenCalledTimes(3);expect(host.shared.release).toHaveBeenCalledTimes(3)
  const prepared=api.prepareMessage({buffer,module},[])
  prepared.rollback();prepared.rollback()
  expect(moduleResources.release).toHaveBeenCalledTimes(4);expect(host.shared.release).toHaveBeenCalledTimes(4)
})
