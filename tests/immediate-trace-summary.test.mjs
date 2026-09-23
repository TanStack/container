import {test} from 'node:test'
import assert from 'node:assert/strict'
import {summarizeImmediateTrace} from '../scripts/summarize-immediate-trace.mjs'

const trace=rows=>rows.map(row=>'PIPELINE_IMMEDIATE '+JSON.stringify(row)).join('\n')
test('counts captured callbacks without treating backlog as duplicate execution',()=>{
  const result=summarizeImmediateTrace(trace([
    {phase:'queued',id:1,parent:0,pending:1},
    {phase:'begin',id:1,pending:0},
    {phase:'queued',id:2,parent:1,pending:1},
    {phase:'end',id:1,pending:1},
  ]))
  assert.deepEqual(result.counts,{queued:2,begin:1,end:1})
  assert.deepEqual(result.duplicateStarts,[])
  assert.equal(result.recordingMayBeTruncated,false)
  assert.equal(result.maxScheduledNotStarted,1)
})
test('reports duplicate starts and flags a capped recording',()=>{
  const result=summarizeImmediateTrace(trace([{phase:'begin',id:7},{phase:'begin',id:7}]),2)
  assert.deepEqual(result.duplicateStarts,[{id:7,count:2}])
  assert.equal(result.recordingMayBeTruncated,true)
})
test('reads complete counters separately from capped cancellation-aware detail',()=>{
  const totals={queued:20,begun:18,ended:18,cancelled:2,pending:0,maxPending:4}
  const result=summarizeImmediateTrace(trace([{phase:'cancel',id:1,pending:0}])+'\nPIPELINE_IMMEDIATE_TOTALS '+JSON.stringify(totals),1)
  assert.equal(result.counts.cancel,1)
  assert.deepEqual(result.totals,totals)
  assert.equal(result.recordingMayBeTruncated,true)
})
