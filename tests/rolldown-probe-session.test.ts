import {afterEach,expect,test,vi} from 'vitest'
import {RolldownProbeSession} from '../src/compiler/rolldown-probe-session'

afterEach(()=>vi.unstubAllGlobals())

function workerFixture(){
  vi.stubGlobal('crossOriginIsolated',true)
  const worker={
    onmessage:null as null|((event:{data:unknown})=>void),
    onerror:null,
    terminate:vi.fn(),
    postMessage:vi.fn((data:any)=>{
      if(data.type==='start')queueMicrotask(()=>worker.onmessage?.({data:{type:'ready',resources:{}}}))
      if(data.command==='close')queueMicrotask(()=>worker.onmessage?.({data:{type:'result',id:data.id,value:{resources:{active:0}}}}))
    }),
  }
  return worker
}

test.each(['sync','async'])('returns %s callback failure to compiler without waiting for a deadline',async mode=>{
  const worker=workerFixture()
  const callback=mode==='sync'?()=>{throw Error('Plugin failed')}:async()=>{throw Error('Plugin failed')}
  const session=await RolldownProbeSession.open({createWorker:()=>worker as unknown as Worker,files:{},callback})
  try{
    worker.onmessage!({data:{type:'callback',id:7,method:'transform',args:[]}})
    await vi.waitFor(()=>expect(worker.postMessage).toHaveBeenCalledWith({type:'reply',id:7,error:'Error: Plugin failed'}))
  }finally{await session.close()}
  expect(worker.terminate).toHaveBeenCalledOnce()
})

test('sends typed parser command and returns materialized result',async()=>{
  const worker=workerFixture()
  const session=await RolldownProbeSession.open({createWorker:()=>worker as unknown as Worker,files:{},callback:async()=>null})
  const expected={program:'{"node":{},"fixes":[]}',module:{},comments:[],errors:[]}
  try{
    const result=session.parse('test.ts','const answer: number = 42',{lang:'ts'})
    await vi.waitFor(()=>expect(worker.postMessage).toHaveBeenCalledWith({type:'command',id:1,command:'parse',filename:'test.ts',source:'const answer: number = 42',options:{lang:'ts'}}))
    worker.onmessage!({data:{type:'result',id:1,value:expected}})
    expect(await result).toEqual(expected)
  }finally{await session.close()}
  await expect(session.parse('test.js','')).rejects.toThrow('Compiler session is closed')
})
