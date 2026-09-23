import {test,expect,vi} from 'vitest'
import {runBrowserCompiler,type BrowserCompilerOptions} from '../src/compiler/browser-compiler-runner'

function setup(){
  const worker={postMessage:vi.fn(),terminate:vi.fn(),onmessage:null as any,onerror:null as any}
  const options:BrowserCompilerOptions={createWorker:()=>worker as unknown as Worker,runtimeURL:'/wasm_exec.js',bytes:new Uint8Array([0,97,115,109,1,0,0,0,5,4,1,1,1,2]),maxMemoryPages:2,argv:['esbuild'],cwd:'/workspace',env:{},timeoutMs:1000,call:vi.fn(async()=>undefined),readStdin:vi.fn(async()=>null),writeStdout:vi.fn(async()=>{}),writeStderr:vi.fn(async()=>{})}
  return {worker,options,emit:(data:unknown)=>worker.onmessage({data})}
}
test('output acknowledgement waits for owner backpressure and exit terminates worker',async()=>{
  const {worker,options,emit}=setup()
  let release!:()=>void
  options.writeStdout=()=>new Promise(resolve=>{release=resolve})
  const result=runBrowserCompiler(options)
  const output=emit({type:'rpc',id:1,op:'stdio.stdout',args:[new Uint8Array([42])]})
  expect(worker.postMessage).toHaveBeenCalledTimes(1)
  release();await output
  expect(worker.postMessage).toHaveBeenLastCalledWith({type:'reply',id:1,value:undefined})
  await emit({type:'exit',code:0});await expect(result).resolves.toEqual({code:0})
  expect(worker.terminate).toHaveBeenCalledOnce()
})
test('abort terminates worker and suppresses late filesystem replies',async()=>{
  const {worker,options,emit}=setup(),controller=new AbortController()
  let release!:(value:unknown)=>void
  options.signal=controller.signal;options.call=()=>new Promise(resolve=>{release=resolve})
  const result=runBrowserCompiler(options)
  const request=emit({type:'rpc',id:1,op:'stat',args:['/workspace']})
  controller.abort();await expect(result).rejects.toMatchObject({name:'AbortError'})
  release({});await request
  expect(worker.postMessage).toHaveBeenCalledTimes(1);expect(worker.terminate).toHaveBeenCalledOnce()
})
test('rejects uncapped artifacts before starting worker',async()=>{
  const {worker,options}=setup()
  options.bytes=new Uint8Array([0,97,115,109,1,0,0,0,5,3,1,0,1])
  await expect(runBrowserCompiler(options)).rejects.toThrow('must already have')
  expect(worker.postMessage).not.toHaveBeenCalled()
})
test('workflow wall-clock deadline terminates idle worker',async()=>{
  const {worker,options}=setup();options.timeoutMs=5
  await expect(runBrowserCompiler(options)).rejects.toThrow('deadline exceeded')
  expect(worker.terminate).toHaveBeenCalledOnce()
})
