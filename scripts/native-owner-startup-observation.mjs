import assert from 'node:assert/strict'

// Browser-test metadata only. Never read or route a request or response body.
export function observeNativeOwnerStartup(page,{previewOrigin,maxEvents=512,maxPending=512,now=Date.now}){
  const origin=new URL(previewOrigin).origin
  assert.equal(previewOrigin,origin)
  for(const value of [maxEvents,maxPending])assert.ok(Number.isSafeInteger(value)&&value>0&&value<=512)
  assert.equal(typeof now,'function')
  const started=now(),events=[],pending=new Map(),ids=new WeakMap(),listeners=[]
  let next=0,dropped=0,pendingDropped=0,requests=0,finished=0,failed=0,phase='startup',stopped=false
  const metadata=request=>{
    let url
    try{url=new URL(request.url())}catch{return}
    if(url.origin!==origin)return
    return {method:request.method(),pathname:url.pathname,queryKeys:[...new Set(url.searchParams.keys())]}
  }
  const append=(kind,request,extra={})=>{
    const fields=metadata(request)
    if(!fields)return
    let id=ids.get(request)
    if(!id){id=++next;ids.set(request,id)}
    const row={id,kind,phase,elapsedMs:Math.max(0,now()-started),...fields,...extra}
    events.push(row)
    if(events.length>maxEvents){events.shift();dropped++}
    return row
  }
  const on=(name,callback)=>{page.on(name,callback);listeners.push([name,callback])}
  on('request',request=>{
    const row=append('request',request)
    if(!row)return
    requests++
    if(pending.size<maxPending)pending.set(request,row)
    else pendingDropped++
  })
  on('response',response=>{
    const request=response.request(),row=append('response',request,{status:response.status()})
    if(row&&pending.has(request))pending.set(request,{...pending.get(request),status:row.status,headersElapsedMs:row.elapsedMs})
  })
  for(const name of ['requestfinished','requestfailed'])on(name,request=>{
    const timing=request.timing()
    const row=append(name==='requestfinished'?'finished':'failed',request,
      {responseStartMs:timing.responseStart,responseEndMs:timing.responseEnd})
    if(row){if(name==='requestfinished')finished++;else failed++;pending.delete(request)}
  })
  const copy=row=>({...row,queryKeys:[...row.queryKeys]})
  return {
    setPhase(value){assert.ok(typeof value==='string'&&value.length>0&&value.length<=120);phase=value},
    snapshot:()=>({phase,elapsedMs:Math.max(0,now()-started),requests,finished,failed,dropped,pendingDropped,
      pending:[...pending.values()].map(copy),events:events.map(copy)}),
    stop(){if(stopped)return;stopped=true;for(const [name,callback]of listeners)page.off(name,callback);pending.clear()},
  }
}
