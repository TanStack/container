import assert from 'node:assert/strict'
import test from 'node:test'
import {terminalCommandSettled,terminalSettlementComplete,terminalSettlementLine} from '../scripts/probe-local-native-terminal-settlement.mjs'
import {execFileSync} from 'node:child_process'

const row=()=>({preparationComplete:true,inputsUnchanged:true,commands:Array.from({length:60},(_,index)=>({
  passed:true,group:Math.floor(index/3)+1,kind:['source-output','missing-command','after-failure'][index%3],
}))})
test('settlement accounting requires the original preparation and all twenty ordered groups',()=>{
  assert.equal(terminalSettlementComplete(row()),true)
  for(const field of ['preparationComplete','inputsUnchanged']){
    const value=row();value[field]=false;assert.equal(terminalSettlementComplete(value),false)
  }
  const short=row();short.commands.pop();assert.equal(terminalSettlementComplete(short),false)
})
test('failed, duplicated or reordered terminal commands cannot complete settlement',()=>{
  const failed=row();failed.commands[31].passed=false;assert.equal(terminalSettlementComplete(failed),false)
  const duplicate=row();duplicate.commands[31]=duplicate.commands[30];assert.equal(terminalSettlementComplete(duplicate),false)
  const reordered=row();[reordered.commands[3],reordered.commands[6]]=[reordered.commands[6],reordered.commands[3]]
  assert.equal(terminalSettlementComplete(reordered),false)
})
test('settlement requires a fresh executed status marker and the final prompt, not command echo or old output',()=>{
  assert.equal(terminalCommandSettled('same output\nTERMINAL_SETTLED_2:0\nproject $ ','TERMINAL_SETTLED_2',0),true)
  assert.equal(terminalCommandSettled('same output\nTERMINAL_SETTLED_1:0\nproject $ ','TERMINAL_SETTLED_2',0),false)
  assert.equal(terminalCommandSettled('project $ '+terminalSettlementLine('false','TERMINAL_SETTLED_2'),'TERMINAL_SETTLED_2',1),false)
  assert.equal(terminalCommandSettled('TERMINAL_SETTLED_2:0\nproject $ ','TERMINAL_SETTLED_2',127),false)
  assert.equal(terminalCommandSettled('TERMINAL_SETTLED_2:0\n','TERMINAL_SETTLED_2',0),false)
  assert.equal(terminalCommandSettled(null,'TERMINAL_SETTLED_2',0),false)
})
test('ordinary shell completion markers preserve successful, nonzero and missing-command exit codes',()=>{
  for(const [line,status] of [['printf "same output"',0],['false',1],['definitely-not-installed-command',127]]){
    const script=terminalSettlementLine(line,'TERMINAL_SETTLED_9')
    let output,actualStatus=0
    try{output=execFileSync('/bin/sh',['-c',script],{encoding:'utf8',stdio:['ignore','pipe','pipe']})}
    catch(error){actualStatus=error.status;output=error.stdout}
    assert.equal(actualStatus,status)
    assert.ok(output.includes('TERMINAL_SETTLED_9:'+status))
  }
  assert.throws(()=>terminalSettlementLine('true','marker; echo injected'))
})
