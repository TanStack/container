import {expect,test,vi} from 'vitest'
import {VirtualNetwork} from '../src/sandbox/virtual-network'
import {createNativeSyncPortLane,NativeSyncPortHost,NativeSyncPortClient} from '../src/native/sync-port-bridge'

test('a delayed previous notification is not mistaken for the next allocation',()=>{
  const lane=createNativeSyncPortLane(),header=new Int32Array(lane)
  const client=new NativeSyncPortClient({postMessage(){},close(){}} as MessagePort,lane)
  const wait=vi.spyOn(Atomics,'wait')
    .mockImplementationOnce(()=> 'ok')
    .mockImplementationOnce(()=>{
      Atomics.store(header,1,5173);Atomics.store(header,0,1);return 'ok'
    })
  try{
    expect(client.allocate()).toBe(5173)
    expect(wait).toHaveBeenCalledTimes(2)
    expect(wait.mock.calls[1]![3]).toBeLessThanOrEqual(wait.mock.calls[0]![3]!)
  }finally{wait.mockRestore();client.close()}
})

test('repeated notifications do not extend the original allocation deadline',()=>{
  const close=vi.fn()
  const client=new NativeSyncPortClient({postMessage(){},close} as unknown as MessagePort,createNativeSyncPortLane())
  const clock=vi.spyOn(performance,'now')
    .mockReturnValueOnce(0).mockReturnValueOnce(0)
    .mockReturnValueOnce(10000).mockReturnValueOnce(20000).mockReturnValueOnce(30000)
  const wait=vi.spyOn(Atomics,'wait').mockReturnValue('ok')
  try{
    expect(()=>client.allocate()).toThrow('timed out')
    expect(wait.mock.calls.map(call=>call[3])).toEqual([30000,20000,10000])
    expect(close).toHaveBeenCalledOnce()
  }finally{wait.mockRestore();clock.mockRestore();client.close()}
})

test('an unpublished probe port releases its parent reservation before the real server binds',async()=>{
  const network=new VirtualNetwork()
  const {port1,port2}=new MessageChannel()
  const lane=createNativeSyncPortLane()
  const header=new Int32Array(lane)
  const host=new NativeSyncPortHost(network,port1,lane)
  const allocate=async()=>{
    Atomics.store(header,0,0)
    port2.postMessage({type:'allocate',requested:5173})
    const acknowledgement=await Atomics.waitAsync(header,0,0,1000).value
    expect(acknowledgement).not.toBe('timed-out')
    expect(Atomics.load(header,0)).toBe(1)
    expect(Atomics.load(header,1)).toBe(5173)
  }
  try{
    await allocate()
    expect(host.owns(5173)).toBe(true)
    host.release(5173)
    expect(host.owns(5173)).toBe(false)
    await allocate()
    expect(host.owns(5173)).toBe(true)
  }finally{
    host.close()
    port2.close()
  }
})
