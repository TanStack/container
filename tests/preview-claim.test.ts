import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {describe,it,expect,vi} from 'vitest'

function serviceWorker(){
  const listeners=new Map<string,(event:any)=>void>()
  const claimResult=Promise.resolve()
  const claim=vi.fn(()=>claimResult)
  runInNewContext(readFileSync('preview-host/sw.js','utf8'),{
    URL,importScripts:()=>{},
    self:{location:{origin:'https://preview.invalid'},clients:{claim},
      addEventListener:(type:string,listener:(event:any)=>void)=>listeners.set(type,listener),
    },
  })
  return {claim,claimResult,message:listeners.get('message')!}
}

describe('preview service worker bridge claims',()=>{
  it('extends the message event until a same-origin bridge claim finishes',async()=>{
    const worker=serviceWorker(),waitUntil=vi.fn()
    worker.message({data:{type:'claim-workspace-bridge'},source:{url:'https://preview.invalid/__sandbox/bridge.html'},waitUntil})
    expect(worker.claim).toHaveBeenCalledOnce()
    expect(waitUntil).toHaveBeenCalledExactlyOnceWith(worker.claimResult)
    await worker.claimResult
  })

  for(const [name,source,data] of [
    ['foreign origin',{url:'https://foreign.invalid/__sandbox/bridge.html'},{type:'claim-workspace-bridge'}],
    ['different scheme',{url:'http://preview.invalid/__sandbox/bridge.html'},{type:'claim-workspace-bridge'}],
    ['different port',{url:'https://preview.invalid:444/__sandbox/bridge.html'},{type:'claim-workspace-bridge'}],
    ['guest page',{url:'https://preview.invalid/'},{type:'claim-workspace-bridge'}],
    ['bridge path prefix',{url:'https://preview.invalid/__sandbox/bridge.html/extra'},{type:'claim-workspace-bridge'}],
    ['bridge script',{url:'https://preview.invalid/__sandbox/bridge.js'},{type:'claim-workspace-bridge'}],
    ['missing source',undefined,{type:'claim-workspace-bridge'}],
    ['missing source URL',{}, {type:'claim-workspace-bridge'}],
    ['unknown message',{url:'https://preview.invalid/__sandbox/bridge.html'},{type:'claim-everything'}],
    ['missing message',{url:'https://preview.invalid/__sandbox/bridge.html'},undefined],
    ['spoofed payload URL',{url:'https://preview.invalid/guest'},{type:'claim-workspace-bridge',url:'https://preview.invalid/__sandbox/bridge.html'}],
  ] as const)it(`does not claim for ${name}`,()=>{
    const worker=serviceWorker(),waitUntil=vi.fn()
    worker.message({data,source,waitUntil})
    expect(worker.claim).not.toHaveBeenCalled()
    expect(waitUntil).not.toHaveBeenCalled()
  })
})
