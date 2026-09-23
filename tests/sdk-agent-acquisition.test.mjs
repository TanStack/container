import {test} from 'node:test'
import assert from 'node:assert/strict'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {setImmediate} from 'node:timers/promises'

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve}}
const options={skip:!process.env.SDK_OUTPUT,timeout:5000}
const sdk=()=>import(pathToFileURL(resolve(process.env.SDK_OUTPUT,'index.js')).href)

test('packaged agent does not dispatch an already-cancelled restore',options,async()=>{
  const {AgentSession}=await sdk()
  let restoreCalls=0
  const session=new AgentSession({}, {kernel:{async restore(){restoreCalls++}}})
  const controller=new AbortController(),reason=Error('cancel restore')
  controller.abort(reason)
  await assert.rejects(session.restore({snapshot:{files:{}}},controller.signal),error=>error===reason)
  assert.equal(restoreCalls,0)
})

test('packaged agent retains a cancelled file acquisition until cleanup',options,async()=>{
  const {AgentSession}=await sdk()
  const started=deferred(),opened=deferred(),closed=deferred()
  let settled=false,closeCalls=0,writeCalls=0
  const session=new AgentSession({}, {kernel:{
    openFileSession(){started.resolve();return opened.promise},
    async writeFile(){writeCalls++},
  }})
  const controller=new AbortController(),reason=Error('cancel file acquisition')
  const result=session.mkdir({path:'/first'},controller.signal).catch(error=>{settled=true;return error})
  await started.promise
  controller.abort(reason)
  const next=session.write({path:'/second',text:'ok'})
  await setImmediate()
  assert.equal(settled,false)
  assert.equal(writeCalls,0)
  opened.resolve({call(){assert.fail('Cancelled file operation executed')},close(){closeCalls++;return closed.promise}})
  await setImmediate()
  assert.equal(closeCalls,1)
  assert.equal(settled,false)
  assert.equal(writeCalls,0)
  closed.resolve()
  assert.equal(await result,reason)
  await next
  assert.equal(writeCalls,1)
})

test('packaged agent kills and disposes a process acquired after cancellation',options,async()=>{
  const {AgentSession}=await sdk()
  const opened=deferred(),killed=deferred(),disposed=deferred()
  const events=[]
  const session=new AgentSession({}, {kernel:{spawn(){return opened.promise}}})
  const controller=new AbortController(),reason=Error('cancel process acquisition')
  let settled=false
  const result=session.run({command:'node'},controller.signal).catch(error=>{settled=true;return error})
  controller.abort(reason)
  await setImmediate()
  assert.equal(settled,false)
  opened.resolve({
    kill(signal){events.push(signal);return killed.promise},
    dispose(){events.push('dispose');return disposed.promise},
    next(){assert.fail('Cancelled process was consumed')},
  })
  await setImmediate()
  assert.deepEqual(events,['SIGKILL'])
  killed.resolve(true)
  await setImmediate()
  assert.deepEqual(events,['SIGKILL','dispose'])
  assert.equal(settled,false)
  disposed.resolve()
  assert.equal(await result,reason)
})
