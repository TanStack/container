import test from 'node:test'
import assert from 'node:assert/strict'
import {resolve} from 'node:path'
import {verifyRuntimeProvenance,renderRuntimeProvenance} from '../scripts/verify-runtime-provenance.mjs'

test('all default SDK runtime groups have current provenance',()=>{
  const report=verifyRuntimeProvenance(resolve('.'))
  assert.deepEqual(report.errors,[])
  assert.equal(report.summary.groups,10)
  assert.ok(report.groups.every(group=>group.artifacts.length>0))
  assert.ok(report.groups.every(group=>group.licenses.length>0))
  assert.ok(report.groups.every(group=>group.rebuild.available||group.rebuild.unavailableReason))
  assert.match(renderRuntimeProvenance(report),/All recorded hashes, licenses, metadata, and artifact coverage passed/)
})
