import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer,get} from 'node:http'
import {runInNewContext} from 'node:vm'
import {installSafariWorkerHTTPTrace,safariCapacityBridge,safariCapacityInstrumentation,startSafariFrameworkProxy} from '../scripts/safari-framework-proxy.mjs'

test('HTTP trace retains promise, receiver, response and untouched body with bounded metadata',async()=>{
  let received
  const response={status:200,get body(){throw Error('must not inspect body')}}
  const promise=Promise.resolve(response)
  class WorkerHTTP{fetch(...args){received={self:this,args};return promise}}
  const context={WorkerHTTP,URL,performance:{now:()=>1}}
  runInNewContext('('+installSafariWorkerHTTPTrace.toString()+')(WorkerHTTP)',context)
  const server=new WorkerHTTP(),request={url:'https://private.example/?secret=hidden'},extra={private:'data'}
  assert.equal(server.fetch(request,extra),promise)
  assert.equal(received.self,server)
  assert.deepEqual(received.args,[request,extra])
  assert.equal(await promise,response)
  const first=context.__safariWorkerHTTPTrace.snapshot()
  assert.equal(first.events[0].category,'root')
  assert.equal(first.events[1].state,'headers')
  for(let i=0;i<40;i++)await server.fetch(request)
  const snapshot=context.__safariWorkerHTTPTrace.snapshot()
  assert.equal(snapshot.events.length,64)
  assert.equal(snapshot.dropped,18)
  assert.equal(snapshot.scope,'headers-only')
  assert.equal(JSON.stringify(snapshot).includes('private'),false)
})
test('HTTP trace preserves thrown and rejected errors',async()=>{
  const failure=new Error('original'),promise=Promise.reject(failure)
  class WorkerHTTP{fetch(mode){if(mode==='throw')throw failure;return promise}}
  const context={WorkerHTTP,URL,performance:{now:()=>1}}
  runInNewContext('('+installSafariWorkerHTTPTrace.toString()+')(WorkerHTTP)',context)
  const server=new WorkerHTTP()
  assert.throws(()=>server.fetch('throw'),error=>error===failure)
  assert.equal(server.fetch('reject'),promise)
  await assert.rejects(promise,error=>error===failure)
  assert.equal(context.__safariWorkerHTTPTrace.snapshot().events.filter(x=>x.state==='error').length,2)
})

test('diagnostic append is separated from a semicolon-free client call',async()=>{
  const upstream=createServer((request,response)=>{
    if(request.url==='/config.json'){response.end(JSON.stringify({previewOrigin:'http://127.0.0.1:4199'}));return}
    response.setHeader('content-type','text/javascript')
    response.end('let session; function controls() {}\ncontrols()')
  })
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve))
  const proxy=await startSafariFrameworkProxy('http://127.0.0.1:'+upstream.address().port,{traceInstall:true})
  try{
    const client=await(await fetch(proxy.origin+'/client.js')).text()
    class WorkerHTTP{fetch(){return Promise.resolve({status:200})}}
    const context={WorkerHTTP,setInterval:()=>1,clearInterval(){},addEventListener(){}}
    runInNewContext(client,context)
    assert.equal(typeof context.__safariWorkerHTTPTrace.snapshot,'function')
    assert.equal(typeof context.__safariAcceptanceCapacity.snapshot,'function')
  }finally{await proxy.close();await new Promise(resolve=>upstream.close(resolve))}
})

test('request ledger retains forwarding and abort stages with bounded private metadata',async()=>{
  let releaseSlow,startedSlow
  const started=new Promise(resolve=>{startedSlow=resolve})
  const upstream=createServer((request,response)=>{
    if(request.url==='/config.json'){response.end(JSON.stringify({previewOrigin:'http://127.0.0.1:4199'}));return}
    if(request.url==='/slow?secret=private'){releaseSlow=()=>response.end('private body');startedSlow();return}
    response.end('private body')
  })
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve))
  const proxy=await startSafariFrameworkProxy('http://127.0.0.1:'+upstream.address().port,{instrumentCapacity:false})
  try{
    await (await fetch(proxy.origin+'/client.js?secret=private')).text()
    let ledger=proxy.requestLedgerSnapshot()
    assert.deepEqual(ledger.events.map(x=>x.stage),['receive','upstream-headers','upstream-body','downstream-finish'])
    assert.equal(ledger.events[0].category,'client-module')
    assert.equal(ledger.events[2].bytes,12)
    const request=get(proxy.origin+'/slow?secret=private')
    request.on('error',()=>{})
    await started
    request.destroy()
    await new Promise(resolve=>request.once('close',resolve))
    for(let i=0;i<20&&!proxy.requestLedgerSnapshot().events.some(x=>x.stage==='premature-close');i++)await new Promise(resolve=>setTimeout(resolve,5))
    assert.ok(proxy.requestLedgerSnapshot().events.some(x=>x.stage==='premature-close'))
    releaseSlow()
    for(let i=0;i<70;i++)await(await fetch(proxy.origin+'/private?secret=private')).text()
    ledger=proxy.requestLedgerSnapshot()
    assert.equal(ledger.events.length,256)
    assert.equal(ledger.dropped,ledger.total-256)
    assert.equal(JSON.stringify(ledger).includes('private'),false)
  }finally{releaseSlow?.();await proxy.close();await new Promise(resolve=>upstream.close(resolve))}
})

test('existing capacity tick transports bounded traces without extra resource calls',async()=>{
  let tick,calls=0,body
  const phase=Array.from({length:40},(_,traceId)=>({traceId,stage:'workspace-commit',state:'end'}))
  const rows=Array.from({length:6},(_,worker)=>({worker,released:false,messages:{received:100},installStages:phase,installStagesDropped:3,installPhases:phase,installPhasesDropped:2,installTraceLimits:{phase:{stage:'trace',state:'limit'}}}))
  const context={
    session:{kernel:{resources:async()=>{calls++;return {installing:false}},jobProfile:[]}},
    setInterval:fn=>{tick=fn;return 1},clearInterval(){},addEventListener(){},performance:{now:()=>42},
    document:{querySelector:()=>({disabled:false}),querySelectorAll:()=>[{}],visibilityState:'visible',readyState:'complete'},
    __safariWorkerCapacity:{snapshot:()=>({created:6,active:6,released:0,workers:rows})},
    fetch:async(_url,options)=>{body=JSON.parse(options.body)},
  }
  runInNewContext(safariCapacityBridge,context)
  await tick()
  assert.equal(calls,1)
  assert.deepEqual(body.owner,{visibility:'visible',readyState:'complete',iframeCount:1})
  assert.equal(body.workers.total,6)
  assert.equal(body.workers.omitted,2)
  assert.equal(body.workers.workers.length,4)
  const row=body.workers.workers[0]
  assert.equal(row.worker,2)
  assert.equal(row.installStages.length,16)
  assert.equal(row.installStagesTotal,43)
  assert.equal(row.installStagesOmitted,24)
  assert.equal(row.installPhases.length,32)
  assert.equal(row.installPhasesTotal,42)
  assert.equal(row.installPhasesOmitted,8)
  assert.equal(row.installTraceLimits.phase.state,'limit')
  context.document.querySelector=()=>({disabled:true})
  await tick()
  assert.equal(calls,1)
})

test('worker observations separate heartbeats, progress and replies without recording payloads',()=>{
  let native
  class Worker {
    listeners=new Map();sent=[]
    constructor(){native=this}
    addEventListener(type,listener){const rows=this.listeners.get(type)??[];rows.push(listener);this.listeners.set(type,rows)}
    removeEventListener(type,listener){this.listeners.set(type,(this.listeners.get(type)??[]).filter(row=>row!==listener))}
    postMessage(...args){this.sent.push(args)}
    terminate(){}
    emit(data){for(const listener of [...this.listeners.get('message')??[]])listener({data})}
  }
  const context={Worker}
  runInNewContext(safariCapacityInstrumentation,context)
  const worker=new context.Worker('kernel.js')
  worker.postMessage({id:1,method:'init',args:['private input']})
  native.emit({id:1,value:'private result'})
  worker.postMessage({id:2,method:'install',args:[]})
  native.emit({type:'heartbeat'})
  native.emit({id:2,type:'progress'})
  const snapshot=()=>JSON.parse(JSON.stringify(context.__safariWorkerCapacity.snapshot()))
  const row=snapshot().workers[0]
  assert.deepEqual(row.messages,{received:3,heartbeats:1,progress:1,replies:1})
  assert.deepEqual(row.requests,[{id:1,method:'init',status:'replied'},{id:2,method:'install',status:'pending'}])
  assert.equal(JSON.stringify(row).includes('private'),false)
  assert.equal(native.sent.length,2)
  for(let id=3;id<80;id++)worker.postMessage({id,method:'readFile',args:[]})
  assert.equal(snapshot().workers[0].requests.length,32)
  worker.terminate()
  assert.equal(snapshot().active,0)
})

test('phase retention is independent of IO volume and preserves per-channel limit evidence',()=>{
  let emit
  class Worker {
    addEventListener(type,listener){if(type==='message')emit=data=>listener({data})}
    postMessage(){}
    terminate(){}
  }
  const context={Worker}
  runInNewContext(safariCapacityInstrumentation,context)
  new context.Worker('kernel.js')
  const event=(channel,stage,state,traceId)=>emit({type:'sandbox-install-stage',channel,stage,state,traceId,at:traceId,payload:'private'})
  event('phase','install-planning','begin',1)
  event('io','trace','limit',2)
  for(let i=0;i<2200;i++)event('io','stream-read','end',i+3)
  let row=context.__safariWorkerCapacity.snapshot().workers[0]
  assert.equal(row.installPhases.length,1)
  assert.equal(row.installPhasesDropped,0)
  assert.equal(row.installStages.length,128)
  assert.equal(row.installStagesDropped,2073)
  assert.equal(row.installTraceLimits.io.traceId,2)
  event('phase','trace','limit',3000)
  for(let i=0;i<2200;i++)event('phase','package-file-write','end',4000+i)
  row=context.__safariWorkerCapacity.snapshot().workers[0]
  assert.equal(row.installPhases.length,2049)
  assert.equal(row.installPhasesDropped,153)
  assert.equal(row.installTraceLimits.phase.traceId,3000)
  assert.equal(JSON.stringify(row).includes('private'),false)
})

test('offline test host preserves bytes and restricts owner and worker connections',async()=>{
  const bytes=Buffer.from([0,97,115,109,1,0,0,0])
  const upstream=createServer((request,response)=>{
    response.setHeader('cross-origin-opener-policy','same-origin')
    response.setHeader('cross-origin-embedder-policy','require-corp')
    if(request.url==='/config.json'){
      response.setHeader('content-type','application/json')
      response.end(JSON.stringify({previewOrigin:'http://127.0.0.1:49999'}))
    }else{response.setHeader('content-type','application/wasm');response.end(bytes)}
  })
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve))
  let proxy
  try{
    proxy=await startSafariFrameworkProxy(`http://127.0.0.1:${upstream.address().port}`)
    const online=await fetch(proxy.origin+'/runtime/engine.wasm')
    assert.equal(online.headers.get('content-security-policy'),null)
    assert.equal(online.headers.get('cross-origin-opener-policy'),'same-origin')
    assert.equal(online.headers.get('cross-origin-embedder-policy'),'require-corp')
    assert.deepEqual(Buffer.from(await online.arrayBuffer()),bytes)
    await fetch(proxy.origin+'/__test/network?mode=offline',{method:'POST'})
    for(const path of ['/','/runtime/workers/kernel.js','/runtime/engine.wasm']){
      const response=await fetch(proxy.origin+path)
      assert.equal(response.headers.get('content-security-policy'),"connect-src 'self' http://127.0.0.1:49999")
      assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes)
    }
    assert.equal((await fetch(proxy.origin+'/__test/network?mode=invalid',{method:'POST'})).status,400)
    assert.equal((await (await fetch(proxy.origin+'/__test/network')).json()).offline,true)
    await fetch(proxy.origin+'/__test/network?mode=online',{method:'POST'})
    assert.equal((await fetch(proxy.origin+'/')).headers.get('content-security-policy'),null)
  }finally{
    await proxy?.close()
    await new Promise(resolve=>upstream.close(resolve))
  }
})
