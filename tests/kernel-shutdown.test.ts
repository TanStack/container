import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'

const state=vi.hoisted(()=>({worker:undefined as any,messages:[] as any[]}))

vi.mock('../src/sandbox/worker-factories',()=>({
  createKernelWorker:()=>{
    const worker={
      onmessage:null as any,
      onerror:null as any,
      postMessage(message:any){
        state.messages.push(message)
        if(message.method==='init')queueMicrotask(()=>worker.onmessage({data:{id:message.id,type:'result',value:null}}))
      },
      terminate:vi.fn(),
    }
    state.worker=worker
    return worker
  },
}))

import {WorkerKernel} from '../src/sandbox/kernel'

const nativeParser={timeoutMs:10,maxSourceBytes:1024}
const tick=async()=>{for(let i=0;i<5;i++)await Promise.resolve()}
const shutdownRequest=()=>{
  const request=state.messages.find(message=>message.method==='shutdown')
  expect(request).toBeDefined()
  return request
}

beforeEach(()=>{
  state.messages=[]
  vi.stubGlobal('location',{href:'http://localhost/'})
})

afterEach(()=>{
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('kernel worker shutdown ownership',()=>{
  it('terminates an ordinary kernel immediately when no native parser is enabled',async()=>{
    const kernel=new WorkerKernel()
    await tick()

    kernel.close()

    expect(state.messages.some(message=>message.method==='shutdown')).toBe(false)
    expect(state.worker.terminate).toHaveBeenCalledOnce()
    await expect(kernel.shutdown).resolves.toBeUndefined()
  })

  it('lets a native-parser worker close itself after successful shutdown',async()=>{
    const kernel=new WorkerKernel({}, {experimentalRolldownParser:nativeParser})
    await tick()

    kernel.close()
    const request=shutdownRequest()
    expect(state.worker.terminate).not.toHaveBeenCalled()

    state.worker.onmessage({data:{id:request.id,type:'result',value:null}})

    await expect(kernel.shutdown).resolves.toBeUndefined()
    expect(state.worker.terminate).not.toHaveBeenCalled()
  })

  it('force-terminates a native-parser worker when shutdown reports an error',async()=>{
    const kernel=new WorkerKernel({}, {experimentalRolldownParser:nativeParser})
    await tick()

    kernel.close()
    const request=shutdownRequest()
    state.worker.onmessage({data:{id:request.id,type:'result',error:'Native parser cleanup failed'}})

    await expect(kernel.shutdown).rejects.toThrow('Native parser cleanup failed')
    expect(state.worker.terminate).toHaveBeenCalledOnce()
  })

  it('force-terminates a native-parser worker when shutdown acknowledgement times out',async()=>{
    vi.useFakeTimers()
    const kernel=new WorkerKernel({}, {experimentalRolldownParser:nativeParser})
    await tick()

    kernel.close()
    shutdownRequest()
    expect(state.worker.terminate).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1021)

    await expect(kernel.shutdown).rejects.toThrow('Native parser shutdown acknowledgement timed out')
    expect(state.worker.terminate).toHaveBeenCalledOnce()
  })
})
