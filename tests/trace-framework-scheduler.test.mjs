import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {traceFrameworkScheduler} from './sdk/helpers/trace-framework-scheduler.mjs'

test('scheduler trace enables counters without job profiling or deadline changes',()=>{
  const source=readFileSync(new URL('../examples/sdk-frameworks/client.js',import.meta.url),'utf8')
  const result=traceFrameworkScheduler(source)
  assert.ok(result.includes('diagnostics:true,guestWasm:true'))
  assert.ok(result.includes('globalThis.__frameworkSchedulerKernel=session.kernel'))
  assert.ok(!result.includes('profileJobs:true'))
  assert.equal(result.match(/timeoutMs:30000/g)?.length,source.match(/timeoutMs:30000/g)?.length)
  assert.throws(()=>traceFrameworkScheduler(result),/integration site/)
  assert.throws(()=>traceFrameworkScheduler(''),/integration site/)
})

test('worker scheduling traces are opt-in and marked diagnostic',()=>{
  const source=readFileSync(new URL('./sdk/framework-example.spec.mjs',import.meta.url),'utf8')
  assert.ok(source.includes("process.env.SDK_TRACE_WORKER_SCHEDULING==='1'"))
  assert.match(source,/traceScheduling\)evidence\.diagnosticOnly=true/)
  assert.ok(source.includes('if(traceScheduling){'))
})
