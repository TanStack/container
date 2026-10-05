import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import {nativeOwnerTimingRecord,writeNativeOwnerTimings} from '../scripts/native-owner-timings.mjs'

const input=()=>({browser:'webkit',example:'basic-ssr-file-based',result:{
  timings:{startMs:14200,developmentMs:4300},
  startupStages:[{phase:'filesystem-connected',elapsedMs:12},{phase:'entry-ready',elapsedMs:14200}],
  source:'not timing metadata',requests:[{body:'not timing metadata'}],
}})

test('development timings do not require a production build',()=>{
  const value=input(),record=nativeOwnerTimingRecord(value)
  assert.deepEqual(record,{browser:value.browser,example:value.example,
    timings:value.result.timings,startupStages:value.result.startupStages})
  assert.equal('checkpointBytes' in record,false)
  assert.equal('source' in record,false);assert.equal('requests' in record,false)
})

test('production timing fields keep their existing flat record shape',()=>{
  const value=input()
  value.result.production={checkpointBytes:1234,checkpointChunks:2,restoreMs:40,restoreTimes:[40,35],body:'not timing metadata'}
  const record=nativeOwnerTimingRecord(value)
  assert.deepEqual(record,{browser:value.browser,example:value.example,timings:value.result.timings,
    startupStages:value.result.startupStages,checkpointBytes:1234,checkpointChunks:2,restoreMs:40,restoreTimes:[40,35]})
  record.restoreTimes.push(99);record.timings.startMs=0;record.startupStages[0].phase='changed'
  assert.deepEqual(value.result.production.restoreTimes,[40,35])
  assert.equal(value.result.timings.startMs,14200);assert.equal(value.result.startupStages[0].phase,'filesystem-connected')
})

test('disabled timing output does not inspect returned metadata or call the sink',()=>{
  let reads=0,writes=0
  writeNativeOwnerTimings({enabled:false,browser:'webkit',example:'fixture',
    result:{get timings(){reads++;throw Error('must not read')}},write:()=>writes++})
  assert.equal(reads,0);assert.equal(writes,0)
})

test('enabled output writes exactly one JSON record from returned data',()=>{
  const value=input(),rows=[]
  writeNativeOwnerTimings({...value,enabled:true,write:line=>rows.push(line)})
  assert.equal(rows.length,1);assert.deepEqual(JSON.parse(rows[0]),nativeOwnerTimingRecord(value))
})

test('invalid timing values fail instead of becoming misleading JSON',()=>{
  for(const bad of [-1,NaN,Infinity,'12',undefined]){
    const value=input();value.result.timings.startMs=bad
    assert.throws(()=>nativeOwnerTimingRecord(value),/Invalid timing duration/)
  }
  const value=input();value.result.startupStages[0].elapsedMs=-1
  assert.throws(()=>nativeOwnerTimingRecord(value),/Invalid timing duration/)
})

test('untimed child-worker phases remain visible without a fabricated timestamp',()=>{
  const value=input()
  value.result.startupStages.push({phase:'worker:1:thread-environment-ready'})
  const record=nativeOwnerTimingRecord(value)
  assert.deepEqual(record.startupStages.at(-1),{phase:'worker:1:thread-environment-ready'})
  assert.equal('elapsedMs' in record.startupStages.at(-1),false)
  for(const bad of [null,NaN,Infinity,'12']){
    value.result.startupStages.at(-1).elapsedMs=bad
    assert.throws(()=>nativeOwnerTimingRecord(value),/Invalid timing duration/)
  }
})

test('the installed workload prints development timings outside the production branch',()=>{
  const source=readFileSync('tests/native-owner-sdk.test.mjs','utf8')
  assert.match(source,/\n            writeNativeOwnerTimings\(\{enabled:process\.env\.NATIVE_OWNER_TIMINGS==='1',/)
  assert.doesNotMatch(source,/if\(process\.env\.NATIVE_OWNER_TIMINGS==='1'\)console\.log/)
  assert.match(source,/result:real\}\)\n            console\.log/)
})
