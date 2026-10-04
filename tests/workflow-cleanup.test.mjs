import {test} from 'node:test'
import assert from 'node:assert/strict'
import {runWithCleanup} from '../scripts/run-with-cleanup.mjs'

test('preserves workflow results and always awaits cleanup',async()=>{
  let cleaned=false
  assert.equal(await runWithCleanup(async()=>42,async()=>{cleaned=true}),42)
  assert.equal(cleaned,true)
})
test('preserves the primary error when cleanup succeeds',async()=>{
  const error=new Error('interaction failed')
  await assert.rejects(runWithCleanup(async()=>{throw error},async()=>{}),value=>value===error)
})
test('reports cleanup failure when the workflow succeeds',async()=>{
  const error=new Error('shutdown failed')
  await assert.rejects(runWithCleanup(async()=>42,async()=>{throw error}),value=>value===error)
})
test('retains both failures in order, including non-Error throws',async()=>{
  const error=new Error('shutdown failed')
  await assert.rejects(runWithCleanup(async()=>{throw undefined},async()=>{throw error}),value=>
    value instanceof AggregateError&&value.errors.length===2&&value.errors[0]===undefined&&value.errors[1]===error)
})
