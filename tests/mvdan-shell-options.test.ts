import {describe,expect,it} from 'vitest'
import {runMvdanShell} from '../src/sandbox/mvdan-shell'
import type {WorkerKernel} from '../src/sandbox/kernel'

const kernel=null as unknown as WorkerKernel

describe('shell option validation',()=>{
  it.each([
    [{cwd:'project'},'cwd'],
    [{cwd:'/bad\0path'},'cwd'],
    [{env:{'BAD=KEY':'value'}},'environment'],
    [{env:{BAD:'value\0'}},'environment'],
    [{env:Object.fromEntries(Array.from({length:129},(_,index)=>['K'+index,'v']))},'environment'],
    [{stdin:new Uint8Array(1024*1024+1)},'stdin'],
    [{signal:{} as AbortSignal},'signal'],
  ] as const)('rejects invalid options before opening a kernel session',async(options,part)=>{
    await expect(runMvdanShell(kernel,'true',options)).rejects.toThrow(part)
  })

  it('rejects an already-aborted signal before opening a kernel session',async()=>{
    const controller=new AbortController();controller.abort()
    await expect(runMvdanShell(kernel,'true',{signal:controller.signal})).rejects.toMatchObject({name:'AbortError'})
  })
})
