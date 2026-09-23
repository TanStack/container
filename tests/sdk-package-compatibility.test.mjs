import test from 'node:test'
import assert from 'node:assert/strict'
import {buildCompatibilityMatrix,discoverCompatibilityPackages} from '../scripts/sdk-compatibility-matrix.mjs'

test('package discovery is deterministic and limited to declared local locks',()=>{
  const first=discoverCompatibilityPackages(),second=discoverCompatibilityPackages()
  assert.deepEqual(first,second)
  assert.ok(first.some(row=>row.name==='vite'&&row.version==='7.3.6'))
  assert.ok(first.some(row=>row.name==='vite'&&row.version==='8.3.0'))
  assert.ok(first.some(row=>row.name==='vitest'&&row.version==='3.2.7'))
  assert.ok(first.some(row=>row.name==='vitest'&&row.version==='5.0.0'))
  assert.ok(first.every(row=>!row.lockfile.startsWith('.toolchains/')))
})

test('static matrix separates unavailable packages and queued browser work',()=>{
  const report=buildCompatibilityMatrix({runNative:false})
  assert.ok(report.gates.length>0)
  assert.ok(report.gates.every(row=>row.static.status==='passed'&&row.native.status==='not-run'))
  assert.deepEqual(report.browserQueue.map(row=>row.status),['queued','queued','queued','queued'])
  assert.ok(report.discovered.some(row=>!row.installed))
})
