import assert from 'node:assert/strict'
import test from 'node:test'
import { assertEditedPreview, checkEditedPreview } from '../scripts/native-edited-preview.mjs'

const counter = { id: 'start-counter', before: 'Add 1 to', after: 'Terminal add 1 to' }

test('edited Counter requires one updated button and no retired SSR content', () => {
  assertEditedPreview({ text: 'Terminal add 1 to 0?', counters: ['Terminal add 1 to 0?'] }, counter)
  assert.throws(() => assertEditedPreview({
    text: 'Add 1 to 0?\nTerminal add 1 to 0?',
    counters: ['Add 1 to 0?', 'Terminal add 1 to 0?'],
  }, counter), /old preview text is still present/)
})

test('two edited buttons cannot pass even without the old label', () => {
  assert.throws(() => assertEditedPreview({
    text: 'Terminal add 1 to 0?\nTerminal add 1 to 0?',
    counters: ['Terminal add 1 to 0?', 'Terminal add 1 to 0?'],
  }, counter), /exactly one counter button/)
  assert.throws(() => assertEditedPreview({ text: 'Terminal add 1 to', counters: [] }, counter), /exactly one counter button/)
})

test('other edited examples require their old text to disappear too', () => {
  const example = { id: 'start-basic', before: 'Welcome Home!!!', after: 'Terminal Home!!!' }
  assertEditedPreview({ text: 'Terminal Home!!!' }, example)
  assert.throws(() => assertEditedPreview({ text: 'Welcome Home!!! Terminal Home!!!' }, example), /old preview text/)
  assert.throws(() => assertEditedPreview({ text: 'Welcome Home!!!' }, example), /edited text is missing/)
})

test('the browser check reads the actual body and does not add waits or mutations', async () => {
  const calls = []
  const snapshot = { text: 'Terminal add 1 to 2?', counters: ['Terminal add 1 to 2?'] }
  const frame = { locator(selector) {
    calls.push(selector)
    return { evaluate: async callback => {
      const body = { innerText: snapshot.text, querySelectorAll(selector) {
        calls.push(selector)
        return snapshot.counters.map(textContent => ({ textContent }))
      } }
      return callback(body)
    } }
  } }
  assert.deepEqual(await checkEditedPreview(frame, counter), snapshot)
  assert.deepEqual(calls, ['body', 'button'])
})

test('browser failures remain failures', async () => {
  const failure = Error('Preview frame detached')
  await assert.rejects(checkEditedPreview({ locator: () => ({ evaluate: async () => { throw failure } }) }, counter), error => error === failure)
})
