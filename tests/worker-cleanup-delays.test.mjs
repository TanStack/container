import {test} from 'node:test'
import assert from 'node:assert/strict'
import {analyzeWorkerCleanupDelays as analyze} from '../scripts/analyze-worker-cleanup-delays.mjs'

const send={pid:2,sample:{kind:'send',protocol:'cleanup-thread',endpoint:2,tid:46,sentAt:4070}}
const receive={pid:1,sample:{kind:'receive',protocol:'cleanup-thread',endpoint:2,tid:46,token:3,receivedAt:4071}}
const settled={pid:1,sample:{...receive.sample,settledAt:5632}}
const artifact=(rows,batches=[])=>({evidence:{workerLifecycle:rows,jobProfileAfterDispose:[{pid:1,phase:'scheduler-check-batches',dropped:0,checkBatches:batches}]}})

test('arrival and settlement updates form one delivery, independent of update order',()=>{
  for(const rows of [[send,receive,settled],[send,settled,receive]]){
    const result=analyze(artifact(rows)).cleanups[0]
    assert.equal(result.status,'matched');assert.equal(result.receiveDeliveries,1)
    assert.equal(result.sendToSettlementMs,1562)
  }
})
test('duplicate sends and conflicting settlements remain ambiguous',()=>{
  assert.equal(analyze(artifact([send,send,settled])).cleanups[0].status,'ambiguous')
  assert.equal(analyze(artifact([send,settled,{...settled,sample:{...settled.sample,settledAt:5700}}])).cleanups[0].status,'ambiguous')
})
test('missing observations never mean unfinished work',()=>{
  assert.equal(analyze(artifact([send])).cleanups[0].status,'receive-not-observed')
  assert.equal(analyze(artifact([send,receive])).cleanups[0].status,'settlement-not-observed')
  assert.equal(analyze({}).traceCompleteness,'not-established')
  assert.ok(analyze(artifact(Array(256).fill(send))).warnings.some(value=>value.includes('capacity')))
})
test('overlap measures only recorded completed parent batches',()=>{
  const result=analyze(artifact([send,settled],[{sequence:9,at:4060,endAt:5626,callbacks:16},{sequence:10,at:5632,endAt:5640},{sequence:11,at:4100}]))
  assert.deepEqual(result.cleanups[0].overlappingCheckBatches,[{sequence:9,at:4060,endAt:5626,callbacks:16,overlapMs:1556}])
  assert.ok(result.warnings.some(value=>value.includes('no recorded end')))
})
