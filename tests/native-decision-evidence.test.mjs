import {test} from 'node:test'
import assert from 'node:assert/strict'
import {verifyNativeDecisionEvidence} from '../scripts/native-decision-evidence.mjs'

const fixture=()=>{
  const cases=Array.from({length:40},(_,i)=>({id:'case-'+i}))
  return {cases,browsers:['chromium','firefox'].map(name=>({name,pageErrors:[],consoleErrors:[],
    context:cases.map(({id})=>({id,lowered:{matches:true}})),
    viteDev:{result:{listening:true,htmlStatus:200,html:true,moduleStatus:200,module:true,editedStatus:200,edited:true,hmrConnected:true,hmrUpdate:'update'}},
    workloads:{install:{runtime:'native-worker',packages:1,files:1,bytes:1,sha256:'a'.repeat(64)},results:[
      ...Array.from({length:3},()=>({type:'vite-build',passed:true})),
      {type:'start-build-and-native-ssr',execution:'worker-owned-entry',load:{ok:true},responses:Array.from({length:3},()=>({ok:true,value:{status:200}}))},
    ]},resume:{files:1,bytes:1,sha256:'a'.repeat(64),artifacts:['/app/dist/server/server.js']},
    preview:{passed:true,errors:[],mismatchedOrigin:{status:403},serverReply:JSON.stringify({method:'POST',origin:'http://test.invalid',clonedOrigin:'http://test.invalid'}),edit:{loaded:{ok:true}}},
    controls:{terminatedBeforeCompletion:true,pendingRejected:true,hostHeartbeatTicks:1},
  }))}
}
test('successful experiment never grants replacement approval',()=>{
  assert.deepEqual(verifyNativeDecisionEvidence(fixture()),{experimentPassed:true,replacementApproved:false,reason:'Native context gaps, missing guest heap quota and incomplete full-runtime parity remain.'})
})
test('workspace drift, missing browser, preview error, and context regression fail evidence',()=>{
  for(const mutate of [
    report=>{report.browsers[0].resume.sha256='b'.repeat(64)},
    report=>{report.browsers.pop()},
    report=>{report.browsers[0].preview.errors.push('unexpected')},
    report=>{report.browsers[0].context[0].lowered.matches=false},
    report=>{report.browsers[0].controls.pendingRejected=false},
    report=>{report.browsers[0].preview.mismatchedOrigin.status=200},
    report=>{report.browsers[0].viteDev.result.module=false},
    report=>{report.browsers[0].viteDev.result.edited=false},
    report=>{report.browsers[0].viteDev.result.hmrUpdate='none'},
    report=>{report.browsers[0].workloads.install.runtime='page'},
  ]){const report=fixture();mutate(report);assert.throws(()=>verifyNativeDecisionEvidence(report))}
})
