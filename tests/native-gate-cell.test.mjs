import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {nativeGateCellTimeout,nativeGateTestArguments} from '../scripts/native-gate-cell.mjs'

test('gate deadlines validate before child startup',()=>{
  assert.equal(nativeGateCellTimeout(undefined),300000)
  assert.equal(nativeGateCellTimeout('120000'),120000)
  for(const value of ['',0,-1,'1.5','NaN','Infinity',3600001])assert.throws(()=>nativeGateCellTimeout(value))
})

test('a pending gate fails instead of waiting forever',()=>{
  const fixture=fileURLToPath(new URL('./fixtures/native-gate-timeout.mjs',import.meta.url))
  const env={...process.env}
  delete env.NODE_TEST_CONTEXT
  const result=spawnSync(process.execPath,nativeGateTestArguments(100,fixture),{encoding:'utf8',timeout:5000,env})
  assert.equal(result.error,undefined)
  assert.equal(result.status,1)
  assert.match(result.stdout+result.stderr,/timed out|timeout/i)
})
