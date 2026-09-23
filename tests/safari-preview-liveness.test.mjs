import {test} from 'node:test'
import assert from 'node:assert/strict'
import {runInNewContext} from 'node:vm'
import {installSafariPreviewLiveness,installSafariPreviewCollector} from '../scripts/safari-preview-liveness.mjs'

test('preview emits metadata only, at most120 ticks, and removes listeners',()=>{
  const listeners=new Map(),messages=[];let tick,clears=0
  const context={crypto:{randomUUID:()=> 'doc1'},performance:{now:()=>42},
    document:{readyState:'complete',querySelector:s=>s==='main'?{getAttribute:()=> 'true'}:{textContent:'private heading'}},
    parent:{postMessage:(data,origin)=>messages.push({data,origin})},
    setInterval:(fn,ms)=>{assert.equal(ms,1000);tick=fn;return 1},clearInterval:()=>{clears++},
    addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)}
  const dispose=runInNewContext('('+installSafariPreviewLiveness.toString()+')("https://owner.test","private heading")',context)
  listeners.get('pagehide')();listeners.get('pageshow')()
  for(let i=0;i<125;i++)tick()
  assert.equal(messages.length,120)
  assert.equal(messages[0].data.kind,'initial')
  assert.equal(messages.at(-1).data.limitReached,true)
  assert.equal(messages.at(-1).data.emissionCount,120)
  assert.equal(messages[0].origin,'https://owner.test')
  assert.equal(messages[0].data.headingMatches,true)
  assert.equal(JSON.stringify(messages).includes('private heading'),false)
  assert.equal(listeners.size,0)
  dispose();tick()
  assert.equal(messages.length,120)
  assert.equal(listeners.size,0)
  assert.ok(clears>=1)
})

test('collector validates source/origin/types, bounds retention and disposes',()=>{
  const source={},listeners=new Map(),frameListeners=new Map()
  const iframe={contentWindow:source,addEventListener:(k,v)=>frameListeners.set(k,v),removeEventListener:k=>frameListeners.delete(k)}
  const context={iframe,addEventListener:(k,v)=>listeners.set(k,v),removeEventListener:k=>listeners.delete(k)}
  const probe=runInNewContext('('+installSafariPreviewCollector.toString()+')(iframe,"https://preview.test")',context)
  const message=listeners.get('message')
  const data={type:'sandbox-preview-liveness',kind:'tick',documentId:'doc',readyState:'complete',hydrated:true,headingMatches:true,at:2,emissionCount:1,limitReached:false,secret:'private'}
  message({source:{},origin:'https://preview.test',data})
  message({source,origin:'https://wrong.test',data})
  message({source,origin:'https://preview.test',data:{...data,at:NaN}})
  message({source,origin:'https://preview.test',data:{...data,hydrated:'true'}})
  message({source,origin:'https://preview.test',data:{...data,serverCallClicked:true}})
  message({source,origin:'https://preview.test',data:{...data,serverCallClicked:true,serverReplyMatches:'true'}})
  assert.equal(probe.snapshot().received,0)
  for(let i=0;i<70;i++)message({source,origin:'https://preview.test',data})
  frameListeners.get('load')()
  const snapshot=probe.snapshot()
  assert.equal(snapshot.events.length,64);assert.equal(snapshot.received,70);assert.equal(snapshot.dropped,6);assert.equal(snapshot.loads,1)
  assert.equal(JSON.stringify(snapshot).includes('private'),false)
  snapshot.events[0].at=100
  assert.equal(probe.snapshot().events[0].at,2)
  probe.dispose();assert.equal(listeners.size,0);assert.equal(frameListeners.size,0)
})

test('server-call observer reports click and expected reply booleans only and tears down',()=>{
  const listeners=new Map(),messages=[];let tick,reply=''
  const context={crypto:{randomUUID:()=> 'doc'},performance:{now:()=>1},
    parent:{postMessage:data=>messages.push(data)},setInterval:fn=>{tick=fn;return 1},clearInterval(){},
    addEventListener(){},removeEventListener(){},
    document:{readyState:'complete',addEventListener:(k,v)=>listeners.set(k,v),removeEventListener:k=>listeners.delete(k),
      querySelector:s=>s==='#server-reply'?{textContent:reply}:s==='main'?{getAttribute:()=> 'true'}:{textContent:'heading'}}}
  runInNewContext('('+installSafariPreviewLiveness.toString()+')("https://owner.test","heading",true)',context)
  assert.equal(messages[0].serverCallClicked,false)
  listeners.get('click')({target:{closest:()=>({})}})
  assert.equal(messages.at(-1).kind,'server-click')
  assert.equal(messages.at(-1).serverCallClicked,true)
  reply='{"method":"POST","private":"secret"}'
  tick()
  assert.equal(messages.at(-1).serverReplyMatches,true)
  assert.equal(JSON.stringify(messages).includes('secret'),false)
  for(let i=0;i<130;i++)tick()
  assert.equal(messages.length,120)
  assert.equal(listeners.size,0)
})
