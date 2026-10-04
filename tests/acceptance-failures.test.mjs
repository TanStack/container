import {test} from 'node:test'
import assert from 'node:assert/strict'
import {recordAcceptanceFailure,assertAcceptancePassed} from '../scripts/acceptance-failures.mjs'

test('continued acceptance failures preserve original errors and fail the final gate',()=>{
  const failures=[],first=Error('source typecheck failed'),second=Error('preview failed')
  const row=recordAcceptanceFailure(failures,{browser:'chromium',example:'source'},first,true)
  assert.equal(row.status,'failed')
  assert.equal(row.browser,'chromium')
  assert.equal(row.error,'Error: source typecheck failed')
  recordAcceptanceFailure(failures,{browser:'firefox'},second,true)
  assert.throws(()=>assertAcceptancePassed(failures,'owner example'),error=>{
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors,[first,second])
    assert.equal(error.message,'2 owner example checks failed')
    return true
  })
})

test('default acceptance failure stops immediately, while an empty run has no failures',()=>{
  const failures=[],original=Error('failed')
  assert.throws(()=>recordAcceptanceFailure(failures,{},original,false),error=>error===original)
  assert.deepEqual(failures,[])
  assert.doesNotThrow(()=>assertAcceptancePassed(failures,'owner example'))
})
