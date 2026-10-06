import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import * as sdk from '../scripts/check-native-sdk.mjs'
import {nativeReleaseExamples} from '../scripts/native-example-sources.mjs'

const makeRows=()=>['chromium','firefox','webkit'].flatMap(browser=>nativeReleaseExamples.map(({kind,path})=>({
  browser,example:kind+'/'+path,timings:{startMs:40},
  startupStages:[{phase:'filesystem-connected',elapsedMs:12},{phase:'entry-ready',elapsedMs:35}],
})))
const output=rows=>rows.map(row=>JSON.stringify(row)).join('\n')

test('SDK timing accounting requires all original framework/example pairs in every engine',()=>{
  const rows=makeRows()
  assert.deepEqual(sdk.readNativeSDKCheckTimings(output(rows)),rows)
  for(const change of [rows=>rows.pop(),rows=>rows.reverse(),rows=>rows[1]=rows[0],
    rows=>rows[4].example='react/start-counter',rows=>rows[5].browser='webkit',
    rows=>rows[0].example='start-counter']){
    const invalid=makeRows();change(invalid)
    assert.throws(()=>sdk.readNativeSDKCheckTimings(output(invalid)))
  }
})

test('partial timing capture preserves a failed run prefix without pretending it completed',()=>{
  const prefix=makeRows().slice(0,14)
  assert.deepEqual(sdk.readNativeSDKCheckTimings(output(prefix),{complete:false}),prefix)
  assert.deepEqual(sdk.readNativeSDKCheckTimings('',{complete:false}),[])
  assert.throws(()=>sdk.readNativeSDKCheckTimings(output(prefix)))
  prefix[0].example='solid/start-counter'
  assert.throws(()=>sdk.readNativeSDKCheckTimings(output(prefix),{complete:false}))
})

test('timing metadata never counts an example result, acceptance row or unrelated diagnostic',()=>{
  const rows=makeRows(),log=output(rows)+'\n'+[
    JSON.stringify({browser:'chromium',example:'TanStack Start counter',development:'passed'}),
    'NATIVE_RELEASE_ACCEPTANCE '+JSON.stringify({browser:'chromium',passed:true}),
    JSON.stringify({kind:'unrelated-diagnostic',value:12}),
  ].join('\n')
  assert.deepEqual(sdk.readNativeSDKCheckTimings(log),rows)
})

test('timing accounting rejects malformed, missing or fabricated duration values',()=>{
  for(const bad of [-1,null,'40']){
    const rows=makeRows();rows[0].timings.startMs=bad
    assert.throws(()=>sdk.readNativeSDKCheckTimings(output(rows)))
  }
  for(const change of [row=>delete row.timings.startMs,row=>row.startupStages=[],
    row=>row.startupStages[1].elapsedMs=1,row=>row.startupStages[1].phase='',
    row=>row.timings.extra=-1,row=>row.development='passed']){
    const rows=makeRows();change(rows[0])
    assert.throws(()=>sdk.readNativeSDKCheckTimings(output(rows)))
  }
  assert.throws(()=>sdk.readNativeSDKCheckTimings('{invalid json'))
})

test('failed SDK commands preserve the original failure while retaining observed timing metadata',()=>{
  const rows=makeRows().slice(0,14),report={passed:false,phase:'desktop SDK acceptance'}
  const error=Object.assign(Error('original browser timeout'),{status:1,stdout:output(rows),stderr:'timeout'})
  assert.throws(()=>sdk.captureNativeSDKCheckTimings(()=>{throw error},report),actual=>actual===error)
  assert.equal(report.passed,false);assert.equal(report.phase,'desktop SDK acceptance')
  assert.deepEqual(report.timings,rows);assert.equal(report.timingsComplete,false)
  assert.equal(error.status,1);assert.equal(error.stderr,'timeout')
})

test('bad or absent failure metadata cannot replace the original command error',()=>{
  for(const stdout of ['{invalid json',null,undefined]){
    const report={passed:false},error=Object.assign(Error('original failure'),{stdout})
    assert.throws(()=>sdk.captureNativeSDKCheckTimings(()=>{throw error},report),actual=>actual===error)
    assert.equal(report.passed,false);assert.equal(report.timingsComplete,false)
    if(typeof stdout==='string')assert.match(report.timingCaptureError,/JSON/)
    else assert.deepEqual(report.timings,[])
  }
})

test('successful SDK output keeps the original bytes and requires complete timing metadata',()=>{
  const log=output(makeRows()),report={passed:false}
  assert.equal(sdk.captureNativeSDKCheckTimings(()=>log,report),log)
  assert.deepEqual(report.timings,makeRows());assert.equal(report.timingsComplete,true)
  assert.equal(report.passed,false,'Timing metadata cannot grant acceptance')
  assert.throws(()=>sdk.captureNativeSDKCheckTimings(()=>output(makeRows().slice(0,14)),{passed:false}))
})

test('timing reporting is wired into the original full SDK command and source CI',()=>{
  const source=readFileSync(new URL('../scripts/check-native-sdk.mjs',import.meta.url),'utf8')
  assert.match(source,/report\.acceptance=readNativeSDKCheckAcceptance\(captureNativeSDKCheckTimings\(\s*\(\)=>execute\('scripts\/native-release-acceptance\.mjs',\[sdk,adoption\.output\.directory\],true\),report\)\)/)
  const workflow=readFileSync(new URL('../.github/workflows/source-checks.yml',import.meta.url),'utf8')
  assert.match(workflow,/run: node --test tests\/native-sdk-timings\.test\.mjs tests\/native-sdk-repeats\.test\.mjs/)
})
