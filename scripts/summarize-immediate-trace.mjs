import {readFileSync} from 'node:fs'
import {pathToFileURL} from 'node:url'

export function summarizeImmediateTrace(text, cap=192) {
  const prefix='PIPELINE_IMMEDIATE '
  const rows=text.split('\n').filter(line=>line.startsWith(prefix)).map(line=>JSON.parse(line.slice(prefix.length)))
  const counts={queued:0,begin:0,end:0},starts=new Map(),parents=new Map()
  const totalsPrefix='PIPELINE_IMMEDIATE_TOTALS '
  const totalLines=text.split('\n').filter(line=>line.startsWith(totalsPrefix))
  const totals=totalLines.length?JSON.parse(totalLines.at(-1).slice(totalsPrefix.length)):null
  let maxScheduledNotStarted=0
  for(const row of rows){
    if((!Object.hasOwn(counts,row.phase)&&row.phase!=='cancel')||!Number.isSafeInteger(row.id))throw Error('Invalid immediate trace row')
    counts[row.phase]=(counts[row.phase]??0)+1
    if(row.phase==='begin')starts.set(row.id,(starts.get(row.id)??0)+1)
    if(row.phase==='queued')parents.set(row.parent,(parents.get(row.parent)??0)+1)
    if(Number.isFinite(row.pending))maxScheduledNotStarted=Math.max(maxScheduledNotStarted,row.pending)
  }
  return {
    events:rows.length,recordingMayBeTruncated:rows.length>=cap,counts,totals,
    duplicateStarts:[...starts].filter(([,count])=>count>1).map(([id,count])=>({id,count})),
    maxScheduledNotStarted,
    busiestSchedulingParents:[...parents].sort((a,b)=>b[1]-a[1]).slice(0,8).map(([id,count])=>({id,count})),
    limitations:totals?'Detail is capped; totals cover wrapper installation through summary emission and account for wrapped clearImmediate calls. Parent 0 means outside a traced immediate callback.':'Captured events only. No complete totals available; older pending counts do not observe cancellation. Parent 0 means outside a traced immediate callback.',
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(process.argv.length<3)throw Error('Provide native or guest pipeline JSON artifact paths')
  for(const path of process.argv.slice(2)){
    const artifact=JSON.parse(readFileSync(path,'utf8'))
    const output=artifact.stdout??artifact.observed?.output?.map(row=>row.text).join('\n')
    if(typeof output!=='string')throw Error('No pipeline output in '+path)
    console.log(JSON.stringify({path,...summarizeImmediateTrace(output)},null,2))
  }
}
