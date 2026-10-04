import test from 'node:test'
import assert from 'node:assert/strict'
import {readHTTPPressureResults} from '../scripts/probe-native-http-pressure.mjs'

const engines = ['chromium', 'firefox', 'webkit']
const guest = () => engines.map(browser => ({browser, version: 'control', passed: true,
  held: 32, completed: 96, responseBytes: 307200, handles: 0}))
const installed = () => engines.map(browser => ({browser, version: 'control', passed: true,
  result: {cancelled: 32, responses: 96, state: {received: 128, finished: 96, held: 32},
    resources: {responseStreams: 0, sockets: 0}, diagnostics: []}}))
const log = rows => rows.map(row => JSON.stringify(row)).join('\n')

test('pressure receipts require the complete guest and installed control results', () => {
  assert.deepEqual(readHTTPPressureResults('phase metadata\n' + log(guest()), false), guest())
  assert.deepEqual(readHTTPPressureResults(log(installed()), true), installed())
})
test('missing, duplicated or failed engines cannot become pressure evidence', () => {
  for (const rows of [guest().slice(0, 2), [...guest(), guest()[0]], guest().map(row => ({...row, passed: false}))])
    assert.throws(() => readHTTPPressureResults(log(rows), false))
})
test('incomplete bytes, cancellation, cleanup or diagnostics fail pressure receipts', () => {
  for (const field of ['held', 'completed', 'responseBytes', 'handles']) {
    const rows = guest(); rows[0][field]++
    assert.throws(() => readHTTPPressureResults(log(rows), false))
  }
  for (const change of [r => r.cancelled--, r => r.responses--, r => r.state.finished--,
    r => r.state.received--, r => r.state.held--, r => r.resources.responseStreams++,
    r => r.resources.sockets++, r => r.diagnostics.push({error: 'control'})]) {
    const rows = installed(); change(rows[0].result)
    assert.throws(() => readHTTPPressureResults(log(rows), true))
  }
})
