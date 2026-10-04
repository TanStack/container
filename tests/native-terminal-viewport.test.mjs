import assert from 'node:assert/strict'
import test from 'node:test'
import { nativeTerminalFailureSnapshot, renderedTerminalEdge, renderedTerminalScan } from '../scripts/native-terminal-viewport.mjs'

test('missing failure terminal never waits for a viewport or hides the workflow error', async () => {
  const terminal = { count: async () => 0, locator() { throw Error('Must not read a removed terminal') } }
  assert.deepEqual(await nativeTerminalFailureSnapshot(terminal), { present: false, terminal: null })
})

test('terminal diagnostic failures become observations, not replacement exceptions', async () => {
  const terminal = { count: async () => { throw Error('Page closed during diagnosis') } }
  assert.deepEqual(await nativeTerminalFailureSnapshot(terminal), { error: 'Error: Page closed during diagnosis' })
})

test('a stalled terminal failure observation stays bounded and never implies success', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = nativeTerminalFailureSnapshot({ count: () => new Promise(() => {}) })
  context.mock.timers.tick(5000)
  assert.deepEqual(await pending, { error: 'Diagnostic observation timed out after 5000ms' })
})

test('failure snapshot reads present rows without waiting for an absent viewport', async () => {
  const terminal = { count: async () => 1, locator: selector => ({
    count: async () => 0,
    textContent: async options => { assert.equal(selector, '.xterm-rows'); assert.equal(options.timeout, 1000); return 'last output' },
    evaluate() { throw Error('Must not wait for an absent viewport') },
  }) }
  assert.deepEqual(await nativeTerminalFailureSnapshot(terminal), { present: true, terminal: 'last output' })
})

function viewAt(screens, index = screens.length - 1) {
  return { read: async () => screens[index], scroll: async direction => {
    index = Math.max(0, Math.min(screens.length - 1, index + direction))
  } }
}

test('virtual terminal edge requires observed movement and repeated stable rows', async () => {
  const result = await renderedTerminalEdge(viewAt(['old', 'middle', 'prompt']), -1, { requireMovement: true })
  assert.deepEqual(result, { screen: 'old', moved: true, steps: 4 })
  await assert.rejects(renderedTerminalEdge(viewAt(['prompt']), -1, { requireMovement: true }), /never moved/)
  assert.equal((await renderedTerminalEdge(viewAt(['prompt']), 1)).moved, false)
})

test('virtual terminal scan checks actual visible screens and never invents a match', async () => {
  assert.deepEqual(await renderedTerminalScan(viewAt(['old', 'wanted', 'prompt']), text => text.includes('wanted')), {
    found: true, screens: ['old', 'wanted'],
  })
  assert.deepEqual(await renderedTerminalScan(viewAt(['old', 'prompt']), text => text.includes('missing')), {
    found: false, screens: ['old', 'prompt'],
  })
})

test('virtual terminal checks reject invalid or never-settling scrollback', async () => {
  for (const value of [0, -1, 1.5, 1025]) await assert.rejects(renderedTerminalEdge(viewAt(['row']), -1, { maxSteps: value }))
  await assert.rejects(renderedTerminalEdge(viewAt(['row']), 0))
  await assert.rejects(renderedTerminalScan(viewAt(['row']), null))
  let sequence = 0
  const moving = { read: async () => String(sequence++), scroll: async () => {} }
  await assert.rejects(renderedTerminalEdge(moving, -1, { maxSteps: 3 }), /never reached/)
})
