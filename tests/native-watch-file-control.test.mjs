import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,unlinkSync,rmdirSync,watchFile,unwatchFile} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

test('Node polling distinguishes omitted interval from invalid explicit values',()=>{
  const target=join(tmpdir(),'container-watch-option-control')
  for(const interval of [null,undefined,'20'])
    assert.throws(()=>watchFile(target,{interval},()=>{}),{code:'ERR_INVALID_ARG_TYPE'})
  for(const interval of [-1,1.5,NaN,Infinity])
    assert.throws(()=>watchFile(target,{interval},()=>{}),{code:'ERR_OUT_OF_RANGE'})
})

test('Node polling deletion and recreation retain the last existing previous stats',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'container-watch-control-'))
  const target=join(directory,'target.txt')
  writeFileSync(target,'before')
  const events=[]
  let exists=true
  try{
    await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(Error('Node polling control timed out')),3000)
      watchFile(target,{interval:10},(current,previous)=>{
        events.push([current.size,previous.size])
        if(current.nlink===0){writeFileSync(target,'recreated');exists=true}
        else{clearTimeout(timeout);resolve()}
      })
      setTimeout(()=>{unlinkSync(target);exists=false},30)
    })
    assert.deepEqual(events,[[0,6],[9,6]])
  }finally{
    unwatchFile(target)
    if(exists)unlinkSync(target)
    rmdirSync(directory)
  }
})
