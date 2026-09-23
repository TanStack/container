import {readFileSync} from 'node:fs'
import {pathToFileURL} from 'node:url'

// Saved observations only. Settlement is not proof of pool return or a scheduler defect.
export function analyzeWorkerCleanupDelays(artifact,parentPid=1){
  const evidence=artifact.evidence??{}
  const lifecycle=Array.isArray(evidence.workerLifecycle)?evidence.workerLifecycle:[]
  const profiles=Array.isArray(evidence.jobProfileAfterDispose)?evidence.jobProfileAfterDispose:[]
  const parentProfiles=profiles.filter(row=>row.pid===parentPid&&row.phase==='scheduler-check-batches')
  const batches=parentProfiles.flatMap(row=>row.checkBatches??[])
  const warnings=['Missing observations do not establish unfinished work. Overlap does not establish causation.',
    'Lifecycle diagnostics are bounded at their producers and collector. Fewer than 256 collector records does not prove a complete trace.']
  if(!Array.isArray(evidence.workerLifecycle))warnings.push('Worker lifecycle trace is missing.')
  if(lifecycle.length>=256)warnings.push('Lifecycle ring reached its 256-record capacity; earlier records may be missing.')
  if(!parentProfiles.length)warnings.push('Parent check-batch profile is missing.')
  if(parentProfiles.some(row=>row.dropped>0))warnings.push('Parent check-batch records were dropped.')
  if(batches.some(row=>!Number.isFinite(row.endAt)))warnings.push('Some check batches have no recorded end; their overlap cannot be measured.')
  // Receive events are emitted once on arrival and again on settlement.
  const receives=new Map(),sends=new Map()
  for(const {pid,sample:s} of lifecycle){
    if(!s||s.protocol!=='cleanup-thread')continue
    if(!Number.isSafeInteger(s.endpoint)||!Number.isSafeInteger(s.tid))continue
    const key=`${s.endpoint}:${s.tid}`
    if(pid!==parentPid&&s.kind==='send'){
      const entries=sends.get(key)??[];entries.push({pid,...s});sends.set(key,entries)
    }
    if(pid===parentPid&&s.kind==='receive'){
      const tokenKey=`${key}:${s.token}`
      const entries=receives.get(tokenKey)??[];entries.push(s);receives.set(tokenKey,entries)
    }
  }
  const deliveries=[...receives.values()].map(rows=>{
    const settled=[...new Set(rows.map(row=>row.settledAt).filter(Number.isFinite))]
    const arrived=[...new Set(rows.map(row=>row.receivedAt).filter(Number.isFinite))]
    return {...rows[0],settledAt:settled[0],conflicting:settled.length>1||arrived.length>1||!Number.isSafeInteger(rows[0].token)}
  })
  const cleanups=[...sends.values()].map(rows=>{
    const send=rows[0],matches=deliveries.filter(row=>row.endpoint===send.endpoint&&row.tid===send.tid)
    const result={pid:send.pid,endpoint:send.endpoint,tid:send.tid,sentAt:send.sentAt,sendRecords:rows.length,receiveDeliveries:matches.length}
    if(rows.length!==1||matches.length>1||matches.some(row=>row.conflicting))return {...result,status:'ambiguous'}
    if(!matches.length)return {...result,status:'receive-not-observed'}
    const receive=matches[0]
    if(!Number.isFinite(receive.settledAt))return {...result,status:'settlement-not-observed'}
    if(!Number.isFinite(send.sentAt)||receive.settledAt<send.sentAt)return {...result,status:'invalid-timestamps'}
    return {...result,status:'matched',receivedAt:receive.receivedAt,settledAt:receive.settledAt,
      sendToSettlementMs:receive.settledAt-send.sentAt,
      overlappingCheckBatches:batches.filter(batch=>Number.isFinite(batch.at)&&Number.isFinite(batch.endAt)&&batch.endAt>=batch.at&&batch.at<receive.settledAt&&batch.endAt>send.sentAt).map(batch=>({sequence:batch.sequence,at:batch.at,endAt:batch.endAt,callbacks:batch.callbacks,overlapMs:Math.min(batch.endAt,receive.settledAt)-Math.max(batch.at,send.sentAt)}))}
  })
  return {parentPid,lifecycleRecords:lifecycle.length,traceCompleteness:'not-established',warnings,cleanups}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [file,parent='1']=process.argv.slice(2)
  if(!file||!Number.isSafeInteger(Number(parent)))throw Error('Usage: node scripts/analyze-worker-cleanup-delays.mjs artifact.json [parentPid]')
  console.log(JSON.stringify(analyzeWorkerCleanupDelays(JSON.parse(readFileSync(file,'utf8')),Number(parent)),null,2))
}
