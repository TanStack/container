import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeFirefoxProtocol } from '../scripts/summarize-native-firefox-protocol.mjs'

const recv = (method, params) => '2026-10-03T03:05:58.000Z pw:protocol ◀ RECV ' + JSON.stringify({ method, params, sessionId: 'test' })

test('protocol summary retains navigation, frame and execution-context events', () => {
  const result = summarizeFirefoxProtocol([
    recv('Runtime.executionContextDestroyed', { executionContextId: 'old' }),
    recv('Page.navigationCommitted', { frameId: 'preview', url: 'http://127.0.0.1:4199/', navigationId: 'new' }),
    recv('Runtime.executionContextCreated', { executionContextId: 'new', auxData: { frameId: 'preview', name: 'utility' } }),
    recv('Page.eventFired', { frameId: 'preview', name: 'load' }),
  ].join('\n'))
  assert.equal(result.parsedInboundMessages, 4)
  assert.equal(result.lifecycle.length, 4)
  assert.equal(result.lifecycle[2].frameId, 'preview')
  assert.equal(result.lifecycle[2].world, 'utility')
  assert.equal(result.lifecycle[3].event, 'load')
})

test('summary omits evaluated code, network headers, unrelated console and nested worker messages', () => {
  const result = summarizeFirefoxProtocol([
    recv('Network.requestWillBeSent', { headers: [{ name: 'Cookie', value: 'private' }] }),
    recv('Runtime.console', { args: [{ value: 'private unrelated output' }] }),
    recv('Page.dispatchMessageFromWorker', { message: JSON.stringify({ method: 'Runtime.executionContextCreated', params: {} }) }),
    'pw:protocol SEND ► {"method":"Runtime.evaluate","params":{"expression":"private code"}}',
  ].join('\n'))
  assert.deepEqual(result.lifecycle, [])
  assert.equal(JSON.stringify(result).includes('private'), false)
})

test('bounded or malformed lines do not invent context events, document traces stay correlated', () => {
  const result = summarizeFirefoxProtocol([
    'pw:protocol ◀ RECV {truncated',
    recv('Runtime.console', { executionContextId: 'old', args: [{ value: '[terminal-document] {"event":"pagehide"}' }] }),
  ].join('\n'))
  assert.equal(result.malformedInboundLines, 1)
  assert.equal(result.lifecycle.length, 1)
  assert.equal(result.lifecycle[0].executionContextId, 'old')
})

test('browser stderr is classified and timed without retaining scripts or stacks', () => {
  const result = summarizeFirefoxProtocol([
    "\x1b[31m2026-10-03T03:05:58.000Z pw:browser [pid=123][err] JavaScript error: chrome://juggler/content/SimpleChannel.js, line 1: SyntaxError: redeclaration of let SimpleChannel private\x1b[0m",
    '2026-10-03T03:05:59.000Z pw:browser [pid=123][err] NS_ERROR_FAILURE chrome://juggler/content/Helper.js removeProgressListener private',
    '2026-10-03T03:06:00.000Z pw:browser [pid=123][err] Script terminated by timeout private stack',
    '2026-10-03T03:06:01.000Z pw:browser [pid=123][err] no WebAssembly compiler available private',
    '2026-10-03T03:06:02.000Z pw:browser [pid=123][err] unrelated private error',
    '2026-10-03T03:06:03.000Z pw:protocol SEND ► Script terminated by timeout private code',
  ].join('\n'))
  assert.deepEqual(result.browserDiagnostics, [
    { time: '2026-10-03T03:05:58.000Z', category: 'juggler-simple-channel-redeclaration' },
    { time: '2026-10-03T03:05:59.000Z', category: 'juggler-progress-listener-failure' },
    { time: '2026-10-03T03:06:00.000Z', category: 'javascript-timeout' },
    { time: '2026-10-03T03:06:01.000Z', category: 'wasm-compiler-unavailable' },
  ])
  assert.equal(JSON.stringify(result).includes('private'), false)
})

test('aborted navigation is retained without raw error details', () => {
  const result = summarizeFirefoxProtocol(recv('Page.navigationAborted', {
    frameId: 'preview', navigationId: 'new', errorText: 'private',
  }))
  assert.equal(result.lifecycle[0].method, 'Page.navigationAborted')
  assert.equal(result.lifecycle[0].navigationId, 'new')
  assert.equal(JSON.stringify(result).includes('private'), false)
})
