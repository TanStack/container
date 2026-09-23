import {afterEach,beforeEach,expect,it,vi} from 'vitest'
const state=vi.hoisted(()=>({worker:undefined as any}))
vi.mock('../src/sandbox/worker-factories',()=>({createKernelWorker:()=>{
  const worker={onmessage:null as any,onerror:null as any,postMessage(message:any){
    if(message.method==='init')queueMicrotask(()=>worker.onmessage({data:{id:message.id,type:'result',value:null}}))
  },terminate:vi.fn()}
  state.worker=worker;return worker
}}))
import {WorkerKernel} from '../src/sandbox/kernel'
import type {PortEvent} from '../src/sdk/index'
let kernel:WorkerKernel
const emit=(type:PortEvent['type'],port:number)=>state.worker.onmessage({data:{type:'port',value:{type,port}}})
beforeEach(async()=>{vi.stubGlobal('location',{href:'http://localhost/'});kernel=new WorkerKernel();await Promise.resolve()})
afterEach(()=>{kernel.close();vi.unstubAllGlobals()})

it('replays current ports in order and returns independent snapshots',()=>{
  emit('open',9000);emit('open',3000)
  const ports=kernel.listeningPorts;ports.push(1)
  expect(kernel.listeningPorts).toEqual([3000,9000])
  const events:PortEvent[]=[]
  kernel.subscribePorts(event=>events.push(event))
  expect(events).toEqual([{type:'open',port:3000},{type:'open',port:9000}])
  emit('close',3000);emit('open',4000)
  expect(events.slice(2)).toEqual([{type:'close',port:3000},{type:'open',port:4000}])
  expect(kernel.listeningPorts).toEqual([4000,9000])
})

it('deduplicates worker events and supports independent idempotent unsubscribe',()=>{
  const callback=vi.fn(),unsubscribe=kernel.subscribePorts(callback)
  kernel.subscribePorts(callback)
  emit('close',3000);emit('open',3000);emit('open',3000)
  expect(callback).toHaveBeenCalledTimes(2)
  unsubscribe();unsubscribe();emit('close',3000);emit('close',3000)
  expect(callback).toHaveBeenCalledTimes(3)
})

it('isolates throwing observers and prevents event mutation across callbacks',()=>{
  emit('open',3000)
  expect(()=>kernel.subscribePorts(()=>{throw Error('observer failed')})).not.toThrow()
  const frozen: boolean[]=[]
  kernel.subscribePorts(event=>{frozen.push(Object.isFrozen(event));(event as any).port=99})
  const events:PortEvent[]=[];kernel.subscribePorts(event=>events.push(event))
  emit('open',4000);emit('close',3000)
  expect(events).toEqual([{type:'open',port:3000},{type:'open',port:4000},{type:'close',port:3000}])
  expect(frozen).toEqual([true,true,true])
  expect(kernel.listeningPorts).toEqual([4000])
  expect(state.worker.terminate).not.toHaveBeenCalled()
})

it('closes current ports once and ignores late worker port messages',()=>{
  const events:PortEvent[]=[];kernel.subscribePorts(event=>events.push(event))
  emit('open',9000);emit('open',3000)
  kernel.close();kernel.close();emit('open',4000);emit('close',3000)
  expect(events).toEqual([{type:'open',port:9000},{type:'open',port:3000},{type:'close',port:3000},{type:'close',port:9000}])
  expect(kernel.listeningPorts).toEqual([])
  expect(()=>kernel.subscribePorts(()=>{})).toThrow('Kernel closed')
  expect(state.worker.terminate).toHaveBeenCalledTimes(1)
})

it('closes ports on worker failure even when a close observer throws',()=>{
  kernel.subscribePorts(()=>{throw Error('observer failed')})
  const callback=vi.fn();kernel.subscribePorts(callback);emit('open',3000)
  state.worker.onerror({message:'Worker failed'})
  expect(callback).toHaveBeenLastCalledWith({type:'close',port:3000})
  expect(kernel.listeningPorts).toEqual([])
  expect(state.worker.terminate).toHaveBeenCalledTimes(1)
})

it('allows closing during notification without delivering stale opens',()=>{
  kernel.subscribePorts(event=>{if(event.type==='open')kernel.close()})
  const callback=vi.fn();kernel.subscribePorts(callback)
  emit('open',3000)
  expect(callback.mock.calls).toEqual([[{type:'close',port:3000}]])
  expect(kernel.listeningPorts).toEqual([])
})

it('stops replay when an observer closes the kernel',()=>{
  emit('open',3000);emit('open',4000)
  const events:PortEvent[]=[]
  kernel.subscribePorts(event=>{events.push(event);if(event.type==='open')kernel.close()})
  expect(events).toEqual([{type:'open',port:3000},{type:'close',port:3000},{type:'close',port:4000}])
})
