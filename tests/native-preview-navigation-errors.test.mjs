import { test } from 'node:test'
import assert from 'node:assert/strict'
import { unexpectedPreviewErrors } from '../scripts/native-preview-navigation-errors.mjs'

const phase = 'counter reload 2'
const url = 'http://127.0.0.1:45233/node_modules/react/index.js'
const error = `${phase}: TypeError: error loading dynamically imported module: ${url}`
const traces = [
  `${phase}: [native-document] error old TypeError: error loading dynamically imported module: ${url}`,
  `${phase}: [native-document] pagehide old`,
  `${phase}: [native-document] start new http://127.0.0.1:45233/`,
]
const aborted = `${phase}: {"errorText":"NS_BINDING_ABORTED"} detached=false,url=http://127.0.0.1:45233/ ${url}`

test('accepts an aborted import only from the outgoing preview document', () => {
  assert.deepEqual(unexpectedPreviewErrors([error], traces, [aborted]), [])
})

test('keeps active, uncorrelated, and non-navigation errors visible', () => {
  assert.deepEqual(unexpectedPreviewErrors([error], traces.slice(0, 1), [aborted]), [error])
  assert.deepEqual(unexpectedPreviewErrors([error], traces, []), [error])
  assert.deepEqual(unexpectedPreviewErrors([error], traces,
    [aborted.replace(url, 'http://127.0.0.1:45233/other.js')]), [error])
  const streaming = 'streaming button 1: TypeError: Importing a module script failed.'
  assert.deepEqual(unexpectedPreviewErrors([streaming], traces, [aborted]), [streaming])
})

test('terminal-triggered navigation requires the same outgoing document and canceled request evidence', () => {
  const terminalPhase='terminal command mkdir -p work && cd work && pwd'
  const terminalError=error.replace(phase,terminalPhase)
  const terminalTraces=traces.map(trace=>trace.replace(phase,terminalPhase))
  const terminalAborted=aborted.replace(phase,terminalPhase)
  assert.deepEqual(unexpectedPreviewErrors([terminalError],terminalTraces,[terminalAborted]),[])
  assert.deepEqual(unexpectedPreviewErrors([terminalError],terminalTraces.slice(0,1),[terminalAborted]),[terminalError])
  assert.deepEqual(unexpectedPreviewErrors([terminalError],terminalTraces,[]),[terminalError])
  assert.deepEqual(unexpectedPreviewErrors([terminalError],terminalTraces,
    [terminalAborted.replace(url,'http://127.0.0.1:45233/other.js')]),[terminalError])
  const hydration=terminalPhase+': Hydration failed because the server rendered text did not match.'
  assert.deepEqual(unexpectedPreviewErrors([hydration],terminalTraces,[terminalAborted]),[hydration])
})

test('an outgoing terminal document may finish leaving after the next command starts',()=>{
  const terminalPhase='terminal command 1'
  const terminalError=error.replace(phase,terminalPhase)
  const terminalTraces=traces.map(trace=>trace.replace(phase,terminalPhase))
  terminalTraces[1]=terminalTraces[1].replace(terminalPhase,'terminal command 2')
  const terminalAborted=aborted.replace(phase,terminalPhase)
  assert.deepEqual(unexpectedPreviewErrors([terminalError],terminalTraces,[terminalAborted]),[])
  assert.deepEqual(unexpectedPreviewErrors([terminalError],terminalTraces.map(trace=>trace.replace('pagehide old','pagehide unrelated')),[terminalAborted]),[terminalError])
  assert.deepEqual(unexpectedPreviewErrors([terminalError],terminalTraces.map(trace=>trace.replace('terminal command 2','editor change')),[terminalAborted]),[terminalError])
  assert.deepEqual(unexpectedPreviewErrors([terminalError],terminalTraces,[terminalAborted.replace('NS_BINDING_ABORTED','NS_ERROR_FAILURE')]),[terminalError])
})

test('accepts a WebKit outgoing-document error only with a canceled request', () => {
  const webkitError = `${phase}: TypeError: Importing a module script failed.`
  const webkitTraces = [
    `${phase}: [native-document] error old TypeError: Importing a module script failed.`,
    `${phase}: [native-document] pagehide old`,
  ]
  assert.deepEqual(unexpectedPreviewErrors([webkitError], webkitTraces,
    [aborted.replace('NS_BINDING_ABORTED', 'cancelled')]), [])
})
