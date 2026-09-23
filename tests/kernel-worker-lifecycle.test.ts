import {describe,expect,it,vi} from 'vitest'
import {completeKernelWorkerRequest,shutdownKernelResources} from '../src/sandbox/kernel-worker-lifecycle'

describe('kernel worker lifecycle',()=>{
  it('posts the shutdown result before stopping the worker',()=>{
    const order:string[]=[]
    completeKernelWorkerRequest('shutdown',()=>order.push('result'),()=>order.push('heartbeat'),()=>order.push('worker'))
    expect(order).toEqual(['result','heartbeat','worker'])
  })

  it('waits for guest finalizers before closing every compiler',async()=>{
    let finishProcess!:()=>void
    const order:string[]=[],result=new Promise<void>(resolve=>{finishProcess=resolve})
    const first={close:vi.fn(async()=>{order.push('first')})}
    const second={close:vi.fn(async()=>{order.push('second')})}
    const closing=shutdownKernelResources(
      [{owner:0,pid:1,result:result.then(()=>{order.push('process')})}],
      ()=>{order.push('kill')},
      [Promise.resolve(first),Promise.resolve(second)],
    )
    await Promise.resolve()
    expect(order).toEqual(['kill'])
    finishProcess()
    await closing
    expect(order).toEqual(['kill','process','first','second'])
  })

  it('still closes a healthy compiler when its sibling failed to open',async()=>{
    const healthy={close:vi.fn(async()=>{})}
    await expect(shutdownKernelResources([],()=>{},[
      Promise.reject(Error('opening failed')),
      Promise.resolve(healthy),
    ])).rejects.toThrow('Kernel resource shutdown failed')
    expect(healthy.close).toHaveBeenCalledOnce()
  })
})
