import test from 'node:test'
import assert from 'node:assert/strict'
import {ownerStreamRepeatOptions,runOwnerStreamRepeats} from '../scripts/repeat-native-owner-streaming.mjs'

const options=()=>ownerStreamRepeatOptions(['/consumer/sdk','/consumer/hosted','--runs','2'])
const names=['TanStack Start counter','TanStack Start basic','TanStack Start streaming',
  'TanStack Router file-based SSR','Solid Start counter']
const workflow=names.map(example=>JSON.stringify({browser:'firefox',example,development:'passed'})).join('\n')
const observation='NATIVE_STREAM_OBSERVATION '+JSON.stringify({frames:[{rows:[{run:1}]}]})
const identity=()=>({sdk:'fixed',runtime:'fixed',deployment:'fixed',examples:5})

test('repeat command has bounded explicit options and does not accept filters',()=>{
  assert.deepEqual(options(),{sdk:'/consumer/sdk',deployment:'/consumer/hosted',runs:2,browser:'firefox'})
  for(const flags of [['--runs','0'],['--runs','11'],['--browser','all'],['--example','start-counter'],
    ['--runs','2','--runs','3'],['--runs']])
    assert.throws(()=>ownerStreamRepeatOptions(['/sdk','/deployment',...flags]))
})

test('all runs retain failures, original deadlines and a complete workflow requirement',()=>{
  const calls=[]
  const report=runOwnerStreamRepeats(options(),{projectRoot:'/project',identity,
    env:{PATH:'/bin',NATIVE_OWNER_EXAMPLE:'start-counter',NATIVE_OWNER_LOCKLESS:'1'},
    run:(command,args,settings)=>{
      calls.push({command,args,settings})
      return {status:calls.length===1?1:0,stdout:workflow+'\n'+observation,stderr:''}
    }})
  assert.equal(report.rows.length,2);assert.equal(report.passed,false)
  assert.deepEqual(report.rows.map(row=>row.passed),[false,true])
  for(const call of calls){
    assert.ok(call.args.includes('--test-timeout=180000'))
    assert.equal(call.settings.env.NATIVE_OWNER_EXAMPLE,undefined)
    assert.equal(call.settings.env.NATIVE_OWNER_LOCKLESS,undefined)
    assert.equal(call.settings.env.NATIVE_OWNER_STREAM_OBSERVE,'1')
  }
  for(const stdout of [observation,workflow+'\nNATIVE_STREAM_OBSERVATION invalid']){
    const failed=runOwnerStreamRepeats({...options(),runs:1},{projectRoot:'/project',identity,
      run:()=>({status:0,stdout,stderr:''})})
    assert.equal(failed.passed,false)
  }
})

test('changed package inputs stop the repeat instead of marking a mixed run passed',()=>{
  let checks=0
  assert.throws(()=>runOwnerStreamRepeats({...options(),runs:1},{projectRoot:'/project',
    identity:()=>({identity:++checks===1?'before':'changed'}),
    run:()=>({status:0,stdout:workflow+'\n'+observation,stderr:''})}),/Repeat inputs changed/)
})
