import {afterEach,beforeEach,expect,it,vi} from 'vitest'
const state=vi.hoisted(()=>({worker:undefined as any,messages:[] as any[]}))
vi.mock('../src/sandbox/worker-factories',()=>({createKernelWorker:()=>{
  const worker={onmessage:null as any,onerror:null,postMessage(message:any){
    state.messages.push(message)
    if(message.method==='init'||message.method==='cancelInstall')queueMicrotask(()=>worker.onmessage({data:{id:message.id,type:'result',value:null}}))
  },terminate:vi.fn()}
  state.worker=worker;return worker
}}))
import {WorkerKernel} from '../src/sandbox/kernel'
import {AgentSession} from '../src/sdk/agent-session'
let kernel:WorkerKernel
beforeEach(()=>{state.messages=[];vi.stubGlobal('location',{href:'http://localhost/'});kernel=new WorkerKernel()})
afterEach(()=>{kernel.close();vi.useRealTimers();vi.unstubAllGlobals()})
const tick=async()=>{for(let i=0;i<10;i++)await Promise.resolve()}
const reply=(method:string,value?:unknown,error?:string)=>{
  const message=state.messages.find(item=>item.method===method)
  expect(message).toBeDefined()
  state.worker.onmessage({data:{id:message.id,type:'result',value,error}})
}

it('does not start an already aborted installation',async()=>{
  const controller=new AbortController(),reason=Error('User cancelled')
  controller.abort(reason)
  await expect(kernel.install({},controller.signal)).rejects.toBe(reason)
  expect(state.messages.some(item=>item.method==='install')).toBe(false)
})

it('cancels the worker and waits for installation cleanup before releasing queued mutations',async()=>{
  const session=new AgentSession({}, {kernel,telemetry:{capacity:16}})
  const controller=new AbortController(),reason=Error('User cancelled')
  const install=session.install({},controller.signal)
  const rejected=expect(install).rejects.toBe(reason)
  let settled=false;void install.then(()=>{settled=true},()=>{settled=true})
  await tick()
  controller.abort(reason)
  const write=session.write({path:'/after.txt',text:'ready'})
  await tick()
  expect(state.messages.filter(item=>item.method==='cancelInstall')).toHaveLength(1)
  expect(state.messages.find(item=>item.method==='cancelInstall').args).toEqual([state.messages.find(item=>item.method==='install').args[1]])
  expect(settled).toBe(false)
  expect(state.messages.some(item=>item.method==='writeFile')).toBe(false)
  reply('install',undefined,'Package installation cancelled')
  await rejected
  await tick()
  reply('writeFile')
  await write
  expect(session.telemetry?.events().some(item=>item.type==='install.complete')).toBe(false)
})

it('removes the abort listener after a completed installation',async()=>{
  const controller=new AbortController()
  const install=kernel.install({},controller.signal)
  await tick()
  const result={installed:1,skippedPlatformPackages:[],ignoredScripts:[]}
  reply('install',result)
  await expect(install).resolves.toEqual(result)
  controller.abort()
  expect(state.messages.some(item=>item.method==='cancelInstall')).toBe(false)
})

it('reports committed success when cancellation arrives before result delivery',async()=>{
  const controller=new AbortController()
  const install=kernel.install({},controller.signal)
  await tick()
  const result={installed:1,skippedPlatformPackages:[],ignoredScripts:[]}
  reply('install',result)
  // The worker result has arrived, but its promise continuation has not run.
  controller.abort(Error('Too late to cancel committed work'))
  await expect(install).resolves.toEqual(result)
  expect(state.messages.filter(item=>item.method==='cancelInstall')).toHaveLength(1)
})

it('gives concurrent install attempts distinct cancellation tokens',async()=>{
  const firstController=new AbortController(),secondController=new AbortController()
  const first=kernel.install({},firstController.signal),second=kernel.install({},secondController.signal)
  const firstResult=expect(first).rejects.toThrow(),secondResult=expect(second).rejects.toThrow()
  await tick()
  const requests=state.messages.filter(item=>item.method==='install')
  expect(requests).toHaveLength(2)
  expect(requests[0].args[1]).not.toBe(requests[1].args[1])
  firstController.abort();secondController.abort()
  expect(state.messages.filter(item=>item.method==='cancelInstall').map(item=>item.args[0])).toEqual(requests.map(item=>item.args[1]))
  for(const request of requests)state.worker.onmessage({data:{id:request.id,type:'result',error:'Cancelled or busy'}})
  await Promise.all([firstResult,secondResult])
})

it('renews install inactivity only from installer progress',async()=>{
  vi.useFakeTimers()
  const install=kernel.install({}),rejected=expect(install).rejects.toThrow('Kernel request timed out: install (150000ms inactive)')
  await tick()
  const request=state.messages.find(item=>item.method==='install')
  await vi.advanceTimersByTimeAsync(100_000)
  state.worker.onmessage({data:{type:'heartbeat'}})
  state.worker.onmessage({data:{id:request.id,type:'progress'}})
  await vi.advanceTimersByTimeAsync(149_999)
  expect(state.worker.terminate).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  await rejected
  expect(state.worker.terminate).toHaveBeenCalledOnce()
})

it('keeps an absolute install ceiling even while progress continues',async()=>{
  vi.useFakeTimers()
  const install=kernel.install({}),rejected=expect(install).rejects.toThrow('Kernel request timed out: install (300000ms absolute)')
  await tick()
  const request=state.messages.find(item=>item.method==='install')
  for(let elapsed=100_000;elapsed<300_000;elapsed+=100_000){
    await vi.advanceTimersByTimeAsync(100_000)
    state.worker.onmessage({data:{id:request.id,type:'progress'}})
  }
  await vi.advanceTimersByTimeAsync(100_000)
  await rejected
  expect(state.worker.terminate).toHaveBeenCalledOnce()
})
