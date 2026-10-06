import test from 'node:test'
import assert from 'node:assert/strict'
import {checkNativeOwnerSoak,nativeOwnerSoakCycles,runNativeOwnerSoak} from '../scripts/native-owner-soak.mjs'

const complete=()=>Array.from({length:nativeOwnerSoakCycles},(_,index)=>({cycle:index+1,
  http:true,filesystem:true,shellState:true,node:true,stdin:true,interrupt:true,replacement:true,
  freshSession:true,freshProject:true,running:false,commands:0,elapsedMs:1,
  resources:{running:false,starting:false,installing:false,commands:0,terminalSessions:0,responseStreams:0,sockets:0,mutations:0}}))

test('soak requires ten ordered complete cycles, no remaining work or browser errors',()=>{
  assert.deepEqual(checkNativeOwnerSoak(complete()),{cycles:10,passed:true})
  assert.throws(()=>checkNativeOwnerSoak(complete().slice(1)),/Incomplete/)
  assert.throws(()=>checkNativeOwnerSoak(complete(),['crashed']),/browser errors/)
  for(const field of ['http','filesystem','shellState','node','stdin','interrupt','replacement','freshSession','freshProject']){
    const rows=complete();rows[2][field]=false
    assert.throws(()=>checkNativeOwnerSoak(rows),new RegExp(field))
  }
  for(const [field,value] of [['cycle',1],['running',true],['commands',1],['elapsedMs',NaN]]){
    const rows=complete();rows[2][field]=value
    assert.throws(()=>checkNativeOwnerSoak(rows))
  }
  for(const key of ['commands','terminalSessions','responseStreams','sockets','mutations']){
    const rows=complete();rows[2].resources[key]=1
    assert.throws(()=>checkNativeOwnerSoak(rows),/resources/)
  }
})

test('soak stops on first startup failure and preserves the failed cycle',async()=>{
  let starts=0;const observations=[]
  await assert.rejects(runNativeOwnerSoak({start:async(files,options)=>{
    starts++
    assert.equal(options.serveFetchEntry,true)
    assert.equal(Object.hasOwn(options,'previewPort'),false,'Fetch entry selects its own virtual port')
    assert.ok(files['/app/server.mjs'])
    throw Error('startup failed')
  }},row=>observations.push(row)),error=>{
    assert.equal(error.rows.length,1)
    assert.match(error.rows[0].error,/startup failed/)
    return true
  })
  assert.equal(starts,1)
  assert.equal(observations.length,1)
  assert.equal(observations[0].cycle,1)
})
