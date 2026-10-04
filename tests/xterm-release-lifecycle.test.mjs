import assert from 'node:assert/strict'
import test from 'node:test'
import { xtermLifecyclePlan } from '../scripts/probe-xterm-release-lifecycle.mjs'

test('xterm disposal check accepts only private fixtures and bounded desktop runs', () => {
  const fixture = '/private/tmp/native-xterm-release-abc123'
  assert.deepEqual(xtermLifecyclePlan([fixture], {}), {
    fixture, browsers: ['chromium', 'firefox', 'webkit'], repetitions: 20,
  })
  assert.deepEqual(xtermLifecyclePlan([fixture], { NATIVE_BROWSER: 'firefox', NATIVE_XTERM_REPETITIONS: '100' }), {
    fixture, browsers: ['firefox'], repetitions: 100,
  })
  for (const args of [[], [fixture, 'extra'], ['/main-site'], ['/private/tmp/native-xterm-release-abc123/node_modules']])
    assert.throws(() => xtermLifecyclePlan(args, {}))
  for (const value of ['', '0', '101', '-1', '1.5', 'no'])
    assert.throws(() => xtermLifecyclePlan([fixture], { NATIVE_XTERM_REPETITIONS: value }))
  assert.throws(() => xtermLifecyclePlan([fixture], { NATIVE_BROWSER: 'firfox' }))
})
