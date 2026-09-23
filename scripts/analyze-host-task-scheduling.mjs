import {readFile} from 'node:fs/promises'

if(process.argv.length<3)throw new Error('Pass one or more guest.json result paths')
for(const path of process.argv.slice(2)){
  const data=JSON.parse(await readFile(path,'utf8'))
  const traces=data.observed?.hostTaskScheduling??[]
  const dispatches=traces.flatMap(trace=>trace.hostTasks
    .filter(sample=>sample.phase==='dispatch')
    .map(sample=>({pid:trace.pid,...sample,waitMs:sample.dispatchAt-sample.postedAt})))
    .sort((a,b)=>a.dispatchSequence-b.dispatchSequence)
  const inversions=[]
  for(let index=0;index<dispatches.length;index++){
    const current=dispatches[index]
    for(const earlier of dispatches.slice(0,index)){
      if(earlier.pid!==current.pid&&earlier.postSequence>current.postSequence){
        inversions.push({dispatchedFirst:earlier,postedFirst:current})
      }
    }
  }
  console.log(JSON.stringify({path,
    coverage:'Retained samples only. Missing earlier events and undispatched tasks prevent a complete fairness assessment.',
    processes:traces.map(trace=>({pid:trace.pid,count:trace.count,dropped:trace.dropped,retained:trace.hostTasks.length})),
    dispatchCount:dispatches.length,inversionCount:inversions.length,
    inversions:inversions.slice(0,32),omittedInversions:Math.max(0,inversions.length-32),
    longestWaits:[...dispatches].sort((a,b)=>b.waitMs-a.waitMs).slice(0,12),
  },null,2))
}
