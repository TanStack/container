import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {nativeWorkerEvalParent,nativeWorkerEvalExpected} from './fixtures/native-worker-eval.mjs'

test('inline worker code and message lifecycle match real Node',()=>{
  const result=spawnSync(process.execPath,['-e',nativeWorkerEvalParent],{encoding:'utf8',timeout:10000})
  assert.equal(result.error,undefined)
  assert.equal(result.status,0)
  assert.equal(result.stderr,'')
  assert.deepEqual(JSON.parse(result.stdout),nativeWorkerEvalExpected)
})
