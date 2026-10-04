import {test} from 'node:test'
import assert from 'node:assert/strict'
import {declaredBuildEvidence} from '../scripts/native-cli-evidence.mjs'

const success={exitCode:0,stdout:'> build\nvite build\n',stderr:'',outputs:3}
const marker=value=>'DECLARED_BUILD_CLI '+JSON.stringify(value)
test('requires an observed successful command with output artifacts',()=>{
  assert.deepEqual(declaredBuildEvidence(marker(success)),[success])
  for(const value of [{...success,exitCode:2},{...success,outputs:0},
    {...success,outputs:1.5},{exitCode:0,outputs:3}]){
    assert.deepEqual(declaredBuildEvidence(marker(value)),[])
  }
})
test('rejects requested flags, embedded markers and malformed evidence',()=>{
  for(const log of ['NATIVE_REAL_BUILD_CLI=1','tests 1\npass 1',
    'guest stdout '+marker(success),'DECLARED_BUILD_CLI {"exitCode":0',
    'DECLARED_BUILD_CLI null'])assert.deepEqual(declaredBuildEvidence(log),[])
  assert.deepEqual(declaredBuildEvidence('warning\n'+marker(success)+'\n'),[success])
})
