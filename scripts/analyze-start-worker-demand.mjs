import {readFileSync} from 'node:fs'

const [guestPath,nativePath]=process.argv.slice(2)
if(!guestPath||!nativePath)throw Error('Usage: node scripts/analyze-start-worker-demand.mjs <guest-report.json> <native-repeat-report.json>')
const guestReport=JSON.parse(readFileSync(guestPath,'utf8'))
const native=JSON.parse(readFileSync(nativePath,'utf8'))
const guest=guestReport.observed
if(!guest||!Array.isArray(guest.poolAllocations)||!Array.isArray(native.runs)||native.runs.length!==3)throw Error('Expected a traced Start SDK report and three-run native repeat report')
const failures=(guest.jobProfile??[]).filter(row=>row.phase==='worker-start-failure')
const lifecycle=guest.workerLifecycle??[]
function threadStates(failure){
  const matches=guest.poolAllocations.filter(row=>row.phase==='throw'&&row.message===failure.workerStartError?.message)
  if(matches.length!==1)return null // Do not guess between repeated failures.
  return (matches[0].before?.tids??[]).map(tid=>{
    const events=lifecycle.filter(row=>String(row.sample.tid)===String(tid))
    const sent=events.find(row=>row.pid!==failure.pid&&row.sample.protocol==='cleanup-thread'&&row.sample.kind==='send')?.sample
    const received=events.find(row=>row.pid===failure.pid&&row.sample.protocol==='cleanup-thread'&&row.sample.kind==='receive'&&row.sample.settledAt!==undefined)?.sample
    const started=events.find(row=>row.pid!==failure.pid&&row.sample.protocol==='start'&&row.sample.kind==='receive'&&row.sample.settledAt!==undefined)?.sample
    let state='Completion unknown in recorded trace'
    if(received?.settledAt<=failure.at)state='Cleanup settled before rejection, inspect pool bookkeeping'
    else if(sent?.sentAt<=failure.at)state='Cleanup sent before rejection, parent settlement still pending'
    else if(sent)state='Cleanup sent after rejection'
    return {tid:Number(tid),endpoint:sent?.endpoint??started?.endpoint,state,
      startSettledAt:started?.settledAt,cleanupSentAt:sent?.sentAt,cleanupSettledAt:received?.settledAt,
      cleanupSettlementAfterFailureMs:received?received.settledAt-failure.at:undefined}
  })
}
const observed=failures.map(row=>{
  const scheduling=row.workerStartScheduling??{},batch=scheduling.activeCheckBatch
  return {message:row.workerStartError?.message,at:row.at,
    checkBatch:batch?{sequence:batch.sequence,callbacks:batch.callbacks,dispatched:batch.dispatched,remaining:batch.callbacks-batch.dispatched-(batch.cancelled??0)}:null,
    pendingWorkerMessages:scheduling.queued?.workers?.reduce((sum,port)=>sum+port.pending,0)??null,
    pendingSources:scheduling.sources??null,threads:threadStates(row)}
})
const runs=native.runs.map(run=>({repeat:run.repeat,status:run.status,workers:run.workersObserved,
  allocations:run.poolTotals?.allocations,
  renderedBothRoutes:run.status===0&&!run.failure&&run.responses?.length===2&&run.responses.every(response=>response.status===200&&response.expectedContent)}))
console.log(JSON.stringify({
  scope:'Recorded behavior only. Timing-dependent allocation differences do not by themselves establish a scheduler defect.',
  sources:{guest:guestPath,native:nativePath},
  guest:{recordedAllocationAttempts:guest.poolAllocations.length,allocationsTraceBound:16,
    traceMayBeTruncated:guest.poolAllocations.length>=16,
    lifecycleRecords:lifecycle.length,lifecycleMayBeTruncated:lifecycle.length>=256,
    responses:(guest.responses??[]).map(response=>({path:response.path,status:response.status})),
    workflowFailure:guest.failure?.message,allocationFailures:observed},
  native:{runs,observedWorkerCounts:[...new Set(runs.map(run=>run.workers))],allRenderedBothRoutes:runs.every(run=>run.renderedBothRoutes)},
  interpretation:'Queued cleanup during a check batch is not proof that it may be delivered there. Keep the existing native ordering controls and resource policy.',
},null,2))
