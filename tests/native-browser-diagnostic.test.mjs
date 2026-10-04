import assert from 'node:assert/strict'
import test from 'node:test'
import { browserErrorText, diagnosticWithin } from '../scripts/native-browser-diagnostic.mjs'

test('browser errors with empty stacks retain their reported message', () => {
  const reported = { name: '', message: 'RenderErrorCapture', stack: '' }
  assert.equal(browserErrorText(reported), 'RenderErrorCapture')
  assert.equal(browserErrorText({ name: 'TypeError', message: 'original failure', stack: ' ' }), 'TypeError: original failure')
  const error = Error('with a stack')
  assert.equal(browserErrorText(error), error.stack)
  assert.equal(browserErrorText({ name: 'Error', message: '', stack: '' }), 'Error')
  assert.equal(browserErrorText(null), 'null')
  assert.equal(browserErrorText({ toString: () => '' }), 'Browser reported an error without text')
})

test('diagnostic observations preserve successful values and errors', async () => {
  assert.deepEqual(await diagnosticWithin(() => ({ readyState: 'complete' })), { readyState: 'complete' })
  assert.deepEqual(await diagnosticWithin(() => { throw Error('frame detached') }), { error: 'Error: frame detached' })
  assert.deepEqual(await diagnosticWithin(() => Promise.reject(Error('browser closed'))), { error: 'Error: browser closed' })
})

test('a pending browser diagnostic returns a timeout, not a success', async () => {
  const result = await diagnosticWithin(() => new Promise(() => {}), 5)
  assert.deepEqual(result, { error: 'Diagnostic observation timed out after 5ms' })
})

test('late browser rejection remains handled after an observation timeout', async () => {
  let reject
  const pending = new Promise((resolve, fail) => { reject = fail })
  const result = await diagnosticWithin(() => pending, 5)
  assert.match(result.error, /timed out/)
  reject(Error('late rejection'))
  await new Promise(resolve => setImmediate(resolve))
})

test('invalid diagnostic arguments fail before any operation runs', async () => {
  let ran = false
  await assert.rejects(diagnosticWithin(() => { ran = true }, 0), /positive timeout/)
  await assert.rejects(diagnosticWithin(null), /diagnostic operation/)
  assert.equal(ran, false)
})
