import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'

function rejected(script, settings, message) {
  const result = spawnSync(process.execPath, [script], {
    env: { ...process.env, NATIVE_BROWSER: '', NATIVE_EXAMPLES: '',
      NATIVE_EXAMPLE_REPETITIONS: '1', NATIVE_TERMINAL_REPETITIONS: '1',
      NATIVE_HEADLESS: '1', NATIVE_FAILURE_HOLD_MS: '0', ...settings },
    encoding: 'utf8', timeout: 10000,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1)
  assert.match(result.stderr, message)
  assert.equal(result.stdout, '')
}

test('terminal runners reject a mistyped browser before starting work', () => {
  for (const script of ['scripts/test-local-native-terminal.mjs', 'scripts/test-local-native-terminal-examples.mjs'])
    rejected(script, { NATIVE_BROWSER: 'firefoxx' }, /NATIVE_BROWSER must be/)
})

test('expanded terminal repetitions reject zero, fractions, excess and invalid counts', () => {
  for (const count of ['0', '1.5', '11', 'invalid'])
    rejected('scripts/test-local-native-terminal.mjs', { NATIVE_TERMINAL_REPETITIONS: count }, /NATIVE_TERMINAL_REPETITIONS must be/)
})

test('expanded terminal rejects invalid headless selections before browser work', () => {
  for (const value of ['', 'true', 'false', '2'])
    rejected('scripts/test-local-native-terminal.mjs', { NATIVE_HEADLESS: value }, /NATIVE_HEADLESS must be 0 or 1/)
})

test('failure hold is bounded and only allowed in a visible browser', () => {
  for (const value of ['', '-1', '1.5', '120001', 'invalid'])
    rejected('scripts/test-local-native-terminal.mjs', { NATIVE_HEADLESS: '0', NATIVE_FAILURE_HOLD_MS: value }, /NATIVE_FAILURE_HOLD_MS must be/)
  rejected('scripts/test-local-native-terminal.mjs', { NATIVE_FAILURE_HOLD_MS: '100' }, /requires NATIVE_HEADLESS=0/)
})

test('example selection rejects unknown, mixed and empty IDs instead of passing an empty matrix', () => {
  for (const selection of ['missing-example', 'start-counter,missing-example', 'start-counter,', ''])
    rejected('scripts/test-local-native-terminal-examples.mjs', { NATIVE_EXAMPLES: selection }, /NATIVE_EXAMPLES must contain known/)
})

test('Start reload control rejects invalid selectors before browser or host work', () => {
  rejected('scripts/probe-native-start-preview-reload.mjs', { NATIVE_BROWSER: 'firefoxx' }, /Unknown browser engine/)
  for (const count of ['0', '1.5', '51', 'invalid'])
    rejected('scripts/probe-native-start-preview-reload.mjs', { NATIVE_RELOAD_REPETITIONS: count }, /NATIVE_RELOAD_REPETITIONS must be/)
  rejected('scripts/probe-native-start-preview-reload.mjs', { NATIVE_RELOAD_WRITER: 'fake' }, /NATIVE_RELOAD_WRITER must be/)
  rejected('scripts/probe-native-start-preview-reload.mjs', { NATIVE_RELOAD_PRELUDE: 'fake' }, /NATIVE_RELOAD_PRELUDE must be/)
})
