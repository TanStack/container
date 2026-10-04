import assert from 'node:assert/strict'
import test from 'node:test'
import { waitForPinnedStartClient } from '../scripts/native-start-example-readiness.mjs'

test('pinned Start readiness requires its existing exact client UI and original deadline', async () => {
  const calls = []
  await waitForPinnedStartClient({ getByText(text, options) {
    calls.push({ text, options })
    return { waitFor: async options => { calls.push(options) } }
  } })
  assert.deepEqual(calls, [{ text: 'TanStack Router', options: { exact: true } }, { timeout: 45000 }])
})

test('client readiness cannot pass before the UI mounts or swallow a failure', async () => {
  let finish, ready = false
  const pending = new Promise(resolve => { finish = resolve })
  const check = waitForPinnedStartClient({ getByText: () => ({ waitFor: () => pending }) }).then(() => { ready = true })
  await Promise.resolve()
  assert.equal(ready, false)
  finish(); await check
  assert.equal(ready, true)
  const failure = Error('Client control never mounted')
  await assert.rejects(waitForPinnedStartClient({ getByText: () => ({ waitFor: () => Promise.reject(failure) }) }), error => error === failure)
})
