import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { streamedIframePlan, readReloadXterm } from '../scripts/probe-browser-streamed-iframe-reload.mjs'

test('streamed iframe control selects all desktop engines by default', () => {
  assert.deepEqual(streamedIframePlan({}), { browsers: ['chromium', 'firefox', 'webkit'], repetitions: 10,
    transports: ['network', 'service-worker', 'message-port'], history: false, input: 'textarea' })
  assert.deepEqual(streamedIframePlan({ NATIVE_BROWSER: 'firefox', NATIVE_RELOAD_REPETITIONS: '20' }), {
    browsers: ['firefox'], repetitions: 20, transports: ['network', 'service-worker', 'message-port'], history: false, input: 'textarea',
  })
})

test('terminal rendering control requires a declared installed xterm input', () => {
  for (const input of ['', 'shell', 'Xterm']) assert.throws(() => streamedIframePlan({ NATIVE_RELOAD_INPUT: input }))
  assert.throws(() => streamedIframePlan({ NATIVE_RELOAD_INPUT: 'xterm' }))
  assert.equal(streamedIframePlan({ NATIVE_RELOAD_INPUT: 'xterm', NATIVE_RELOAD_XTERM_ROOT: '/installed/xterm' }).input, 'xterm')
})

test('xterm control loads fixed assets with identities and rejects different packages', () => {
  const root = mkdtempSync(join(tmpdir(), 'reload-xterm-test-'))
  try {
    mkdirSync(join(root, 'lib')); mkdirSync(join(root, 'css'))
    writeFileSync(join(root, 'lib/xterm.js'), 'terminal fixture')
    writeFileSync(join(root, 'css/xterm.css'), 'terminal style')
    const manifest = { name: '@xterm/xterm', version: '5.5.0', main: 'lib/xterm.js' }
    const save = value => writeFileSync(join(root, 'package.json'), JSON.stringify(value))
    save(manifest)
    const loaded = readReloadXterm(root)
    assert.deepEqual(Object.keys(loaded.assets), ['/xterm.js', '/xterm.css'])
    assert.equal(loaded.identity.files['/xterm.js'], createHash('sha256').update('terminal fixture').digest('hex'))
    assert.match(loaded.identity.manifestSHA256, /^[a-f0-9]{64}$/)
    for (const changed of [{ name: 'different-package' }, { version: '6.0.0' }, { main: '../outside.js' }]) {
      save({ ...manifest, ...changed })
      assert.throws(() => readReloadXterm(root))
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('streamed iframe control selects declared transport and history cases only', () => {
  assert.deepEqual(streamedIframePlan({ NATIVE_RELOAD_TRANSPORTS: 'message-port', NATIVE_RELOAD_HISTORY: '1' }).transports, ['message-port'])
  assert.equal(streamedIframePlan({ NATIVE_RELOAD_HISTORY: '1' }).history, true)
  for (const transports of ['', 'network,', 'message-port,message-port', 'unknown'])
    assert.throws(() => streamedIframePlan({ NATIVE_RELOAD_TRANSPORTS: transports }))
  for (const history of ['', 'true', '2'])
    assert.throws(() => streamedIframePlan({ NATIVE_RELOAD_HISTORY: history }))
})

test('streamed iframe control rejects unknown engines and invalid repeat counts', () => {
  assert.throws(() => streamedIframePlan({ NATIVE_BROWSER: 'firfox' }))
  for (const count of ['0', '51', '-1', '1.5', 'NaN', ''])
    assert.throws(() => streamedIframePlan({ NATIVE_RELOAD_REPETITIONS: count }))
})
