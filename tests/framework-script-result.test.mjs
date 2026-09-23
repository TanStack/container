import test from 'node:test'
import assert from 'node:assert/strict'
import {parseFrameworkScriptResults,extractFreshFrameworkScriptResult} from './sdk/helpers/framework-script-result.mjs'

const passed='Running test\nTAP version 13\nok 1 - works\ntest exited with status 0\n'
const failed='Running test\nnot ok 1 - fails\ntest exited with status 1\n'

test('parses ordered complete test exit records',()=>{
  assert.deepEqual(parseFrameworkScriptResults(passed+failed+passed),[{exitStatus:0},{exitStatus:1},{exitStatus:0}])
  assert.deepEqual(parseFrameworkScriptResults('test exited with status 2\r\n'),[{exitStatus:2}])
})

test('ignores partial lines, other scripts and embedded status text',()=>{
  assert.deepEqual(parseFrameworkScriptResults('build exited with status 0\n# test exited with status 0\nmessage: "test exited with status 0"\ntest exited with status 0'),[])
  assert.deepEqual(parseFrameworkScriptResults('test exited with status nope\ntest exited with status -1\n'),[])
})

test('extracts only one fresh completion without assuming its status',()=>{
  assert.deepEqual(extractFreshFrameworkScriptResult(passed,0),{exitStatus:0,output:passed})
  const before=parseFrameworkScriptResults(passed).length
  assert.deepEqual(extractFreshFrameworkScriptResult(passed+failed,before),{exitStatus:1,output:passed+failed})
  assert.deepEqual(extractFreshFrameworkScriptResult(passed+failed+passed,2),{exitStatus:0,output:passed+failed+passed})
})

test('rejects stale success, incomplete execution, multiple completions and lost history',()=>{
  for(const [output,before] of [['',0],[passed,1],[passed+'Running test\n',1],[passed+'test exited with status 0',1],[passed+failed,0],[passed,2]]){
    assert.throws(()=>extractFreshFrameworkScriptResult(output,before),/exactly one newly completed test invocation/)
  }
})

test('rejects invalid inputs and unrepresentable exit statuses',()=>{
  for(const output of [undefined,null,[],0])assert.throws(()=>parseFrameworkScriptResults(output),/must be a string/)
  for(const count of [-1,0.5,NaN,Infinity,'0',Number.MAX_SAFE_INTEGER+1])assert.throws(()=>extractFreshFrameworkScriptResult(passed,count),/Invalid prior/)
  assert.throws(()=>parseFrameworkScriptResults('test exited with status 9007199254740992\n'),/Invalid framework script exit status/)
})
