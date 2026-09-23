import {readFile} from 'node:fs/promises'

if(process.argv.length<3)throw new Error('Pass one or more rendered-hmr.json files')
function intervals(events,start,end,key,clock){
  const pending=new Map(),results=[]
  for(const event of events){
    if(event.phase!==start&&event.phase!==end)continue
    const id=key(event)
    if(event.phase===start){
      const queue=pending.get(id)??[]
      queue.push(event[clock]);pending.set(id,queue)
    }else if(event.phase===end){
      const began=pending.get(id)?.shift()
      if(began!==undefined)results.push({path:id,ms:event[clock]-began})
    }
  }
  return results
}
for(const path of process.argv.slice(2)){
  const data=JSON.parse(await readFile(path,'utf8')),evidence=data.evidence??{}
  const http=evidence.httpTrace??[],sw=(data.serviceWorkerTrace??[]).flatMap(row=>row.events??[])
  const profile=evidence.jobProfileAfterDispose??[]
  console.log(JSON.stringify({path,workerMiB:data.effectiveWorkerMiB??(data.policy.workerMaxBytes??data.policy.maxBytes)/1024/1024,
    failed:Boolean(data.workflowError),renderObservation:data.renderObservation,
    httpTraceAtCapacity:http.length>=96,
    requestToHeaders:intervals(http,'fetch-start','headers',row=>row.path,'atMs'),
    serviceWorkerRoundTrip:intervals(sw,'start','response-received',row=>new URL(row.url).pathname,'time'),
    profile:profile.filter(row=>['commonjs-compilation-total','module-source-loading-total','wasm-compile-total','wasm-instantiate-total','wasm-call-inclusive-total','startup-bootstrapMs'].includes(row.phase))
      .map(({pid,phase,ms,jobs})=>({pid,phase,ms,jobs})),
    caution:'Durations overlap across processes and phases. Do not sum them as exclusive CPU time. Missing or capped traces cannot prove zero cost.',
  },null,2))
}
