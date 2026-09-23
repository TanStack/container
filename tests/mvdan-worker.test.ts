import {beforeEach,expect,it,vi} from 'vitest'
const mock=vi.hoisted(()=>({worker:undefined as any}))
vi.mock('../src/sandbox/worker-factories',()=>({createShellWorker:()=>mock.worker}))
import {runMvdanWorker,type MvdanWorkerOptions} from '../src/sandbox/mvdan-worker'
beforeEach(()=>{mock.worker={postMessage:vi.fn(),terminate:vi.fn()}})
const options=():MvdanWorkerOptions=>({script:'cat',cwd:'/project',env:{},timeoutMs:1000,call:vi.fn(async()=>42),readStdin:vi.fn(async()=>new Uint8Array([1,2])),writeStdout:vi.fn(async()=>{}),writeStderr:vi.fn(async()=>{})})
const message=async(data:unknown)=>mock.worker.onmessage({data})
it('streams input, output and process calls through the injected transport',async()=>{
 const o=options(),done=runMvdanWorker(o)
 await message({ready:true})
 expect(mock.worker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({streaming:true}))
 await message({id:1,method:'stdio.read',args:[]})
 expect(mock.worker.postMessage).toHaveBeenLastCalledWith({reply:1,value:new Uint8Array([1,2])})
 await message({id:2,method:'stdio.stdout',args:[new Uint8Array([3])]})
 await message({id:3,method:'stdio.stderr',args:[new Uint8Array([4])]})
 expect(o.writeStdout).toHaveBeenCalledWith(new Uint8Array([3]))
 expect(o.writeStderr).toHaveBeenCalledWith(new Uint8Array([4]))
 await message({id:4,method:'process.spawn',args:[['node','task.js'],'/project',{}]})
 expect(o.call).toHaveBeenCalledWith('process.spawn',[['node','task.js'],'/project',{}])
 await message({result:{code:0,error:''}})
 await expect(done).resolves.toEqual({code:0,error:''})
 expect(mock.worker.terminate).toHaveBeenCalledTimes(1)
})
it('acknowledges output only after the owner accepts it and preserves transport error codes',async()=>{
 const o=options();let release!:()=>void
 o.writeStdout=()=>new Promise(resolve=>{release=resolve})
 o.writeStderr=async()=>{throw Object.assign(Error('closed'),{code:'EPIPE'})}
 const done=runMvdanWorker(o)
 const writing=message({id:1,method:'stdio.stdout',args:[new Uint8Array([1])]})
 expect(mock.worker.postMessage).toHaveBeenCalledTimes(1)
 release();await writing
 await message({id:2,method:'stdio.stderr',args:[new Uint8Array([1])]})
 expect(mock.worker.postMessage).toHaveBeenLastCalledWith({reply:2,error:'Error: closed',code:'EPIPE'})
 await message({result:{code:1,error:'closed'}});await done
})
it('terminates on abort and does not answer a pending transport call afterward',async()=>{
 const o=options(),controller=new AbortController();let release!:(value:null)=>void
 o.signal=controller.signal;o.readStdin=()=>new Promise(resolve=>{release=resolve})
 const done=runMvdanWorker(o),rejected=expect(done).rejects.toMatchObject({name:'AbortError'})
 const reading=message({id:1,method:'stdio.read',args:[]})
 controller.abort();await rejected
 release(null);await reading
 expect(mock.worker.postMessage).toHaveBeenCalledTimes(1)
 expect(mock.worker.terminate).toHaveBeenCalledTimes(1)
})
it('keeps session shells alive past the bounded timeout and disables the worker deadline',async()=>{
 vi.useFakeTimers()
 try{
  const o=options();o.lifetime='session';o.timeoutMs=10
  const done=runMvdanWorker(o)
  await message({ready:true})
  expect(mock.worker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({run:true,timeoutMs:0}))
  await vi.advanceTimersByTimeAsync(100)
  expect(mock.worker.terminate).not.toHaveBeenCalled()
  await message({result:{code:0,error:''}})
  await expect(done).resolves.toEqual({code:0,error:''})
  expect(mock.worker.terminate).toHaveBeenCalledTimes(1)
 }finally{vi.useRealTimers()}
})
