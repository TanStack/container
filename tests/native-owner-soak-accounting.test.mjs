import test from 'node:test'
import assert from 'node:assert/strict'
import {readNativeOwnerSoakResults} from '../scripts/native-owner-soak-accounting.mjs'

const hash='a'.repeat(64),toolchains=[{vite:'8.3.1',rolldown:'1.2.11'},{vite:'8.3.2',rolldown:'1.2.12'}]
function records(){
  const rows=[]
  for(const browser of ['chromium','firefox','webkit']){
    rows.push({kind:'owner-soak-inputs',selected:[browser],cycles:10,testSHA256:hash,workloadSHA256:hash,
      runnerLockSHA256:hash,identity:{sdkManifestSHA256:hash,runtimeManifestSHA256:hash,
        deploymentManifestSHA256:hash,examplesManifestSHA256:hash}})
    for(const toolchain of toolchains){
      const cycles=Array.from({length:10},(_,index)=>({cycle:index+1,http:true,filesystem:true,shellState:true,
        node:true,stdin:true,interrupt:true,replacement:true,freshSession:true,freshProject:true,
        running:false,commands:0,elapsedMs:1,resources:{running:false,starting:false,installing:false,
          commands:0,terminalSessions:0,responseStreams:0,sockets:0,mutations:0}}))
      rows.push(...cycles.map(cycle=>({kind:'owner-soak-cycle',browser,toolchain,...cycle})))
      rows.push({kind:'owner-soak-result',browser,toolchain,version:'test',passed:true,cycles,errors:[],diagnostics:[]})
    }
  }
  return rows
}
const serialize=rows=>rows.map(row=>JSON.stringify(row)).join('\n')

test('soak accounting requires all six pairs and their actual sixty emitted cycles',()=>{
  const result=readNativeOwnerSoakResults(serialize(records()),toolchains)
  assert.equal(result.rows.length,6);assert.equal(result.cycles,60)
  assert.throws(()=>readNativeOwnerSoakResults(serialize(records().slice(1)),toolchains))
  assert.throws(()=>readNativeOwnerSoakResults(serialize(records())+'\n{invalid',toolchains))
})

test('soak accounting rejects incomplete, duplicate, failing or corrupted pairs',()=>{
  for(const mutate of [
    rows=>rows.pop(),
    rows=>{rows[1].cycle=99},
    rows=>{rows.find(row=>row.kind==='owner-soak-result').passed=false},
    rows=>{rows.find(row=>row.kind==='owner-soak-result').errors=['browser failed']},
    rows=>{rows.find(row=>row.kind==='owner-soak-result').diagnostics=['owner failed']},
    rows=>{rows.find(row=>row.kind==='owner-soak-result').version=''},
    rows=>{rows.find(row=>row.kind==='owner-soak-result').cycles[0].resources.sockets=1},
    rows=>{rows.find(row=>row.kind==='owner-soak-result').toolchain=toolchains[1]},
  ]){
    const rows=records();mutate(rows)
    assert.throws(()=>readNativeOwnerSoakResults(serialize(rows),toolchains))
  }
})

test('soak accounting rejects missing or changed source, runner and package identities',()=>{
  for(const key of ['testSHA256','workloadSHA256','runnerLockSHA256'])for(const value of [undefined,'b'.repeat(64)]){
    const rows=records();rows.filter(row=>row.kind==='owner-soak-inputs')[1][key]=value
    assert.throws(()=>readNativeOwnerSoakResults(serialize(rows),toolchains))
  }
  const rows=records();rows.filter(row=>row.kind==='owner-soak-inputs')[1].identity.sdkManifestSHA256='b'.repeat(64)
  assert.throws(()=>readNativeOwnerSoakResults(serialize(rows),toolchains))
})
