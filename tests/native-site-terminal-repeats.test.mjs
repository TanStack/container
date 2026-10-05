import assert from 'node:assert/strict'
import test from 'node:test'
import {terminalMatrixPlan} from '../scripts/probe-local-native-terminal-matrix.mjs'
import {terminalRepeatOptions,terminalRepeatOutcome,runTerminalRepeats} from '../scripts/probe-local-native-terminal-repeats.mjs'

const args=['/private/tmp/tanstack-native-site-test','/private/tmp/sdk-test','/private/tmp/deployment-test']
const options=terminalRepeatOptions(args)
const identity={source:'unchanged'}
function matrix(){return {output:'/private/tmp/test-matrix',identity,complete:true,passed:true,
  rows:terminalMatrixPlan().map(cell=>({...cell,status:0,complete:true,passed:true,inputsUnchanged:true}))}}

test('repeats always require all twelve cells and at least two complete matrices',()=>{
  assert.equal(options.runs,2);assert.equal(options.browser,'all')
  assert.equal(terminalRepeatOptions([...args,'--runs','5']).runs,5)
  for(const flags of [['--runs','1'],['--runs','6'],['--runs','2','--runs','3'],['--browser','webkit'],['--example','start-basic'],['--runs']])
    assert.throws(()=>terminalRepeatOptions([...args,...flags]))
})

test('success markers cannot hide missing cells, changed inputs or child failures',()=>{
  assert.equal(terminalRepeatOutcome(matrix()),true)
  for(const change of [value=>value.rows.pop(),value=>value.rows.reverse(),value=>value.rows[0].status=1,
    value=>value.rows[0].signal='SIGTERM',value=>value.rows[0].complete=false,
    value=>value.rows[0].inputsUnchanged=false,value=>value.rows[0].error='failed',
    value=>value.interrupted='cancelled',value=>value.complete=false]){
    const value=matrix();change(value);assert.equal(terminalRepeatOutcome(value),false)
  }
})

test('every planned matrix runs and a failed first matrix remains failed',async()=>{
  let calls=0
  const receipt=await runTerminalRepeats(options,{inputs:()=>identity,run:async passedOptions=>{
    assert.equal(passedOptions.runs,1);assert.equal(passedOptions.browser,'all')
    const value=matrix();if(++calls===1){value.rows[0].status=1;value.rows[0].passed=false;value.passed=false}
    return value
  }})
  assert.equal(calls,2);assert.equal(receipt.complete,true);assert.equal(receipt.passed,false)
  assert.equal(receipt.rows[0].passed,false);assert.equal(receipt.rows[1].passed,true)
})

test('all planned matrices must have stable matching input identities',async()=>{
  const passed=await runTerminalRepeats(options,{inputs:()=>identity,run:async()=>matrix()})
  assert.equal(passed.complete,true);assert.equal(passed.passed,true)
  let calls=0
  const changed=await runTerminalRepeats(options,{inputs:()=>identity,run:async()=>{
    calls++;return {...matrix(),identity:{source:'changed'}}
  }})
  assert.equal(calls,1);assert.equal(changed.passed,false);assert.equal(changed.complete,false)
  assert.match(changed.stoppedReason,/inputs changed/)
})

test('cancellation and a thrown runner never claim repeated completion',async()=>{
  const controller=new AbortController();controller.abort(Error('cancelled'))
  let calls=0
  const cancelled=await runTerminalRepeats(options,{inputs:()=>identity,signal:controller.signal,run:async()=>{calls++}})
  assert.equal(calls,0);assert.equal(cancelled.complete,false);assert.equal(cancelled.passed,false)
  const failed=await runTerminalRepeats(options,{inputs:()=>identity,run:async()=>{throw Error('runner failed')}})
  assert.equal(failed.complete,false);assert.equal(failed.passed,false);assert.match(failed.runnerError,/runner failed/)
})
