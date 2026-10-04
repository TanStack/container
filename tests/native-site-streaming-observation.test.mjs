import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { observePreviewNetwork, streamedNumberObservation } from '../scripts/native-site-streaming-observation.mjs'

const request = url => ({ url: () => url, method: () => 'GET',
  timing: () => ({ responseStart: 5, responseEnd: 15 }), failure: () => ({ errorText: 'cancelled' }) })

test('preview observations keep timing and status, not credentials or query values', () => {
  const page = new EventEmitter()
  let clock = 10, phase = 'startup'
  const trace = observePreviewNetwork(page, { previewOrigin: 'http://127.0.0.1:4409', phase: () => phase, now: () => clock })
  const req = request('http://127.0.0.1:4409/_serverFn/test?token=private-value&token=second-value#secret')
  page.emit('request', req)
  phase = 'first click'; clock = 20
  page.emit('response', { request: () => req, status: () => 200 })
  page.emit('requestfinished', req)
  page.emit('requestfailed', req)
  page.emit('request', request('http://127.0.0.1:4408/credentials'))
  const result = trace.snapshot()
  assert.equal(result.events.length, 4)
  assert.deepEqual(result.events[0].queryKeys, ['token'])
  assert.equal(result.events[1].status, 200)
  assert.equal(result.events[1].phase, 'first click')
  assert.equal(result.events[1].elapsedMs, 10)
  assert.equal(result.events[2].responseEndMs, 15)
  assert.equal(result.events[3].error, 'cancelled')
  assert.ok(!JSON.stringify(result).includes('private-value'))
  assert.ok(!JSON.stringify(result).includes('secret'))
  trace.stop()
  assert.equal(page.listenerCount('request'), 0)
})

test('preview observations are bounded and snapshots cannot mutate the trace', () => {
  const page = new EventEmitter()
  const trace = observePreviewNetwork(page, { previewOrigin: 'http://127.0.0.1:4409', phase: () => 'startup', maxEvents: 2 })
  for (let i = 0; i < 4; i++) page.emit('request', request('http://127.0.0.1:4409/' + i))
  const result = trace.snapshot()
  assert.equal(result.dropped, 2)
  assert.deepEqual(result.events.map(event => event.url), ['http://127.0.0.1:4409/2', 'http://127.0.0.1:4409/3'])
  result.events[0].queryKeys.push('injected')
  result.events[0].url = 'changed'
  assert.deepEqual(trace.snapshot().events[0].queryKeys, [])
  assert.equal(trace.snapshot().events[0].url, 'http://127.0.0.1:4409/2')
  trace.stop()
})

test('observation rejects invalid inputs and does not invent stream chunks', () => {
  for (const maxEvents of [0, 513, 1.5]) assert.throws(() => observePreviewNetwork(new EventEmitter(), {
    previewOrigin: 'http://127.0.0.1:4409', phase: () => 'startup', maxEvents,
  }))
  assert.deepEqual(streamedNumberObservation('', 0), { elapsedMs: 0, characters: 0, numbers: [] })
  assert.deepEqual(streamedNumberObservation('Number #1: 12\nNumber #2: 8\n', 501), {
    elapsedMs: 501, characters: 27, numbers: [1, 2],
  })
  assert.throws(() => streamedNumberObservation('Number #1: 2', -1))
})
