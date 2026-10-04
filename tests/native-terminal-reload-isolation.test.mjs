import assert from 'node:assert/strict'
import test from 'node:test'
import { isolationPlan, isolationEnvironment, isolationPassed } from '../scripts/probe-native-terminal-reload-isolation.mjs'

test('isolation plan retains baseline, individual checks and the failing combined case', () => {
  const plan = isolationPlan({})
  assert.equal(plan.browser, 'firefox')
  assert.equal(plan.headless, true)
  assert.equal(plan.repetitions, 3)
  assert.deepEqual(plan.cases.map(item => item.name), ['baseline', 'toggle', 'long-edit', 'clear-edit', 'word-edit', 'resize', 'edits', 'edits-resize', 'toggle-resize', 'combined'])
  assert.equal(plan.cases.at(-1).flags.length, 5)
})

test('headed isolation is explicit, validated and forwarded to the unchanged workflow', () => {
  const plan = isolationPlan({ NATIVE_HEADLESS: '0', NATIVE_ISOLATION_CASES: 'combined' })
  assert.equal(plan.headless, false)
  const env = isolationEnvironment({ NATIVE_HEADLESS: '1' }, plan, plan.cases[0], '/private/tmp/test-isolation')
  assert.equal(env.NATIVE_HEADLESS, '0')
  assert.equal(env.NATIVE_LONG_EDIT, '1')
  assert.equal(env.NATIVE_RESIZE, '1')
  for (const value of ['', 'true', 'false', '2'])
    assert.throws(() => isolationPlan({ NATIVE_HEADLESS: value }), /NATIVE_HEADLESS must be 0 or 1/)
})

test('one caller cannot change the flags used by later plans', () => {
  isolationPlan({ NATIVE_ISOLATION_CASES: 'baseline' }).cases[0].flags.push('NATIVE_INSTALL')
  assert.deepEqual(isolationPlan({ NATIVE_ISOLATION_CASES: 'baseline' }).cases[0].flags, [])
})

test('a successful child must finish every planned run, failures and terminations remain failures', () => {
  const finished = { code: 0, signal: null }
  assert.equal(isolationPassed(finished, 3, 3), true)
  for (const completed of [0, 1, 2, 4]) assert.equal(isolationPassed(finished, 3, completed), false)
  assert.equal(isolationPassed(finished, 0, 0), false)
  assert.equal(isolationPassed({ code: 1, signal: null }, 3, 3), false)
  assert.equal(isolationPassed({ code: null, signal: 'SIGTERM' }, 3, 3), false)
  assert.equal(isolationPassed({ ...finished, error: 'Spawn failed' }, 3, 3), false)
})

test('isolation rejects empty, unknown, mixed and duplicate cases and invalid repetitions', () => {
  for (const selection of ['', 'missing', 'baseline,missing', 'baseline,', 'baseline,baseline'])
    assert.throws(() => isolationPlan({ NATIVE_ISOLATION_CASES: selection }), /unique known case names/)
  for (const count of ['0', '1.5', '11', '', 'invalid'])
    assert.throws(() => isolationPlan({ NATIVE_ISOLATION_REPETITIONS: count }), /integer from 1 to 10/)
  assert.throws(() => isolationPlan({ NATIVE_BROWSER: 'firefoxx' }), /NATIVE_BROWSER must be/)
})

test('each case starts with only its declared flags and isolated artifact paths', () => {
  const inherited = { PATH: '/test/bin', NATIVE_BROWSER: 'firefox', NATIVE_SITE_ORIGIN: 'http://127.0.0.1:4198',
    NATIVE_RESIZE: '1', NATIVE_INSTALL: '1', NATIVE_TRACE_PREVIEW_CLICK: '1', NATIVE_TERMINAL_FAILURE_REPORT: '/old/result.json' }
  const plan = isolationPlan({ NATIVE_ISOLATION_CASES: 'word-edit', NATIVE_ISOLATION_REPETITIONS: '2' })
  const env = isolationEnvironment(inherited, plan, plan.cases[0], '/private/tmp/test-isolation')
  assert.equal(env.PATH, '/test/bin')
  assert.equal(env.NATIVE_SITE_ORIGIN, inherited.NATIVE_SITE_ORIGIN)
  assert.equal(env.NATIVE_WORD_EDIT, '1')
  assert.equal(env.NATIVE_SCROLLBACK_FOLLOW, '1')
  assert.equal(env.NATIVE_EDITOR_TO_TERMINAL, '1')
  assert.equal(env.NATIVE_TERMINAL_REPETITIONS, '2')
  for (const key of ['NATIVE_RESIZE', 'NATIVE_INSTALL', 'NATIVE_TRACE_PREVIEW_CLICK']) assert.equal(env[key], undefined)
  assert.equal(env.NATIVE_TERMINAL_FAILURE_REPORT, '/private/tmp/test-isolation/word-edit-failure.json')
})
