import {readFileSync} from 'node:fs'

// Correlate existing diagnostics only. This does not run or change guest code.
const paths=process.argv.slice(2)
if(!paths.length)throw Error('Pass one or more guest pipeline JSON artifacts')
for(const path of paths){
  const artifact=JSON.parse(readFileSync(path,'utf8'))
  const observed=artifact.observed
  const lifecycle=observed.workerLifecycle??[]
  const batches=[]
  for(const profile of observed.jobProfile??[]){
    if(profile.phase!=='scheduler-check-batches')continue
    const records=lifecycle.filter(row=>row.pid===profile.pid).map(row=>row.sample)
    // Receive notifications repeat when settled. Keep the latest state by token.
    const deliveries=new Map()
    for(const row of records)if(row.kind==='receive')deliveries.set(`${row.endpoint}:${row.token}`,row)
    for(const batch of profile.checkBatches){
      if(!batch.queued.workers.length)continue
      const pending=[...deliveries.values()].filter(row=>row.receivedAt<=batch.at&&(row.settledAt===undefined||row.settledAt>batch.at))
      batches.push({pid:profile.pid,sequence:batch.sequence,at:batch.at,completed:batch.endAt!==undefined,
        ports:batch.queued.workers.map(group=>({endpoint:group.endpoint,queued:group.pending,
          labeled:pending.filter(row=>row.endpoint===group.endpoint).map(row=>({token:row.token,protocol:row.protocol,tid:row.tid})),
          state:batch.ports?.find(row=>row.endpoint===group.endpoint)}))})
    }
  }
  console.log(JSON.stringify({path,scenario:artifact.scenario,lifecycleRecords:lifecycle.length,batches},null,2))
}
