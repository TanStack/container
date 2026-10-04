import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {nativeWorkerDataParent,nativeWorkerDataExpected} from './fixtures/native-worker-data-url.mjs'
test('data URL worker module metadata and top-level await match Node',()=>{
  const result=spawnSync(process.execPath,['-e',nativeWorkerDataParent],{encoding:'utf8',timeout:10000})
  assert.equal(result.error,undefined)
  assert.equal(result.status,0)
  assert.equal(result.stderr,'')
  assert.deepEqual(JSON.parse(result.stdout),nativeWorkerDataExpected)
})
