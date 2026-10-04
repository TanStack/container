import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import test from 'node:test'
import {observeNativeOwnerStartup} from '../scripts/native-owner-startup-observation.mjs'
const request=url=>({url:()=>url,method:()=>'GET',timing:()=>({responseStart:1,responseEnd:20})})
const origin='http://127.0.0.1:4409'

test('owner startup keeps unfinished requests separate from received headers',()=>{
  const page=new EventEmitter();let time=10
  const trace=observeNativeOwnerStartup(page,{previewOrigin:origin,now:()=>time})
  const a=request(origin+'/a.js?token=private#secret'),b=request(origin+'/b.js')
  page.emit('request',a);page.emit('request',b)
  time=15;page.emit('response',{request:()=>a,status:()=>200})
  const before=trace.snapshot()
  assert.equal(before.pending.length,2)
  assert.equal(before.pending[0].status,200)
  assert.equal(before.pending[0].headersElapsedMs,5)
  assert.equal(before.finished,0)
  trace.setPhase('before disposal');time=20;page.emit('requestfinished',a)
  page.emit('requestfailed',b)
  const after=trace.snapshot()
  assert.equal(after.finished,1);assert.equal(after.failed,1)
  assert.deepEqual(after.pending,[])
  assert.equal(after.events.at(-1).phase,'before disposal')
  assert.equal(before.pending.length,2)
  assert.ok(!JSON.stringify(after).includes('private'))
  assert.ok(!JSON.stringify(after).includes('secret'))
  trace.stop();assert.equal(page.listenerCount('request'),0)
})

test('pending requests survive a dropped event tail and snapshots are detached',()=>{
  const page=new EventEmitter()
  const trace=observeNativeOwnerStartup(page,{previewOrigin:origin,maxEvents:2,maxPending:2})
  const a=request(origin+'/a'),b=request(origin+'/b'),c=request(origin+'/c')
  for(const req of [a,b,c])page.emit('request',req)
  const snapshot=trace.snapshot()
  assert.equal(snapshot.dropped,1);assert.equal(snapshot.pendingDropped,1)
  assert.deepEqual(snapshot.pending.map(row=>row.pathname),['/a','/b'])
  snapshot.pending[0].pathname='changed';snapshot.pending[0].queryKeys.push('injected')
  assert.equal(trace.snapshot().pending[0].pathname,'/a')
  assert.deepEqual(trace.snapshot().pending[0].queryKeys,[])
  page.emit('requestfinished',a);page.emit('requestfailed',c)
  assert.equal(trace.snapshot().pending.length,1)
  assert.equal(trace.snapshot().requests,3)
  assert.equal(trace.snapshot().finished,1);assert.equal(trace.snapshot().failed,1)
  trace.stop();trace.stop()
})

test('owner startup ignores other origins and invalid metadata',()=>{
  const page=new EventEmitter(),trace=observeNativeOwnerStartup(page,{previewOrigin:origin})
  page.emit('request',request('https://registry.npmjs.org/pkg'))
  page.emit('request',request('invalid'))
  assert.equal(trace.snapshot().requests,0)
  for(const value of ['',null,'x'.repeat(121)])assert.throws(()=>trace.setPhase(value))
  trace.stop()
  for(const value of [0,513,1.5])assert.throws(()=>observeNativeOwnerStartup(page,{previewOrigin:origin,maxEvents:value}))
  assert.throws(()=>observeNativeOwnerStartup(page,{previewOrigin:origin+'/path'}))
})
