import assert from 'node:assert/strict'
import {nativeWorkerPreloadExpected,nativeWorkerNestedPreloadExpected} from '../tests/fixtures/native-worker-preloads.mjs'
import {nativeWorkerDataExpected} from '../tests/fixtures/native-worker-data-url.mjs'

// Keep the acceptance requirements separate from the browser test's execution.
export const nativeCommandBootstrapRequirements=[
  {name:'eval',json:{compiler:false,answer:42}},
  {name:'stdin',json:{compiler:false,answer:42}},
  ...['plain.cjs','legacy/plain.js','legacy/bin'].map(name=>({name,json:{compiler:false,answer:42}})),
  {name:'package-module-bin',stdout:'module-bin:42'},
  {name:'package-module-js',stdout:'module-js'},
  {name:'module',json:{compiler:true,answer:42}},
  {name:'module-eval',json:{compiler:true,answer:42}},
  {name:'dynamic',json:{before:false,compiler:true,answer:42}},
  {name:'timer',stdout:'timer'},
  {name:'failure',status:1,error:'bootstrap guest failure'},
  {name:'worker-formats',json:{before:false,results:[{compiler:false,answer:42},{compiler:false,answer:42},{compiler:true,answer:42},{before:false,compiler:true,answer:42}],after:false}},
  {name:'worker-preloads',json:nativeWorkerPreloadExpected},
  {name:'worker-inherited-preloads',json:nativeWorkerPreloadExpected},
  {name:'worker-nested-preloads',json:nativeWorkerNestedPreloadExpected},
  {name:'worker-data-url',json:nativeWorkerDataExpected},
]

export function readNativeCommandBootstrapResults(output,toolchains){
  assert.ok(Array.isArray(toolchains)&&toolchains.length===2,'Bootstrap CI requires both shipped toolchains')
  const records=String(output).split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line))
  const inputs=records.filter(row=>row.kind==='command-bootstrap-inputs')
  assert.equal(inputs.length,1,'Bootstrap CI requires exactly one input identity')
  for(const field of ['testSHA256','runnerLockSHA256'])assert.match(inputs[0][field]??'',/^[a-f0-9]{64}$/)
  assert.deepEqual(inputs[0].selected,['chromium','firefox','webkit'],'Bootstrap CI must select all three engines')
  const rows=records.filter(row=>row.kind==='command-bootstrap-result')
  assert.equal(rows.length,6,'Bootstrap CI must complete both toolchains in every engine')
  for(const browser of inputs[0].selected)for(const toolchain of toolchains){
    const matching=rows.filter(row=>row.browser===browser&&row.toolchain?.vite===toolchain.vite&&row.toolchain?.rolldown===toolchain.rolldown)
    assert.equal(matching.length,1,'Missing or duplicate bootstrap pair: '+browser+'/'+toolchain.vite)
    const row=matching[0]
    assert.equal(row.passed,true,'Bootstrap command execution failed')
    assert.deepEqual(row.errors,[],'Bootstrap CI reported browser errors')
    assert.deepEqual(row.commands?.map(command=>command.name),nativeCommandBootstrapRequirements.map(entry=>entry.name),'Bootstrap CI skipped or changed a command case')
    for(const [index,command]of row.commands.entries()){
      const expected=nativeCommandBootstrapRequirements[index],label=browser+'/'+toolchain.vite+'/'+expected.name
      assert.equal(command.status,expected.status??0,'Wrong command exit status: '+label)
      assert.equal(command.commands,0,'Bootstrap CI left a command running: '+label)
      assert.equal(command.truncated,false,'Bootstrap CI lost command output: '+label)
      assert.equal(command.cwd,'/app','Bootstrap CI used a different working directory: '+label)
      assert.ok(Number.isSafeInteger(command.elapsedMs)&&command.elapsedMs>=0,'Invalid command timing: '+label)
      assert.equal(typeof command.stdout,'string','Missing stdout: '+label)
      assert.equal(typeof command.stderr,'string','Missing stderr: '+label)
      if(expected.error)assert.ok(command.stderr.includes(expected.error),'Wrong guest failure: '+label)
      else assert.equal(command.stderr,'','Unexpected stderr: '+label)
      if(expected.json)assert.deepEqual(JSON.parse(command.stdout),expected.json,'Wrong command result: '+label)
      if(expected.stdout!==undefined)assert.equal(command.stdout,expected.stdout,'Wrong command output: '+label)
    }
  }
  return {inputs:inputs[0],rows}
}
