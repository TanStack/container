import assert from 'node:assert/strict'
import test from 'node:test'
import { contextInitializationModel } from '../scripts/probe-firefox-context-initialization.mjs'

// Synthetic callbacks verify the model harness, not vendor behavior.
const callbacks = `class Synthetic {
  _onGlobalObjectCleared() {
    this._worldNameToContext.clear();
    if (this.domWindow().document.documentElement) this._initializeExecutionContexts();
  }
  _initializeExecutionContexts() {
    this._worldNameToContext.set('', this._runtime.createExecutionContext());
  }
  _frameNavigationCommitted(frame) {
    frame._initializeExecutionContexts();
  }
  onWindowEvent(event) {
    const frame=this.frameForDocShell(event.target.documentGlobal.docShell);
    if (frame._pendingNavigationId) this._frameNavigationCommitted(frame);
  }
}`

test('callback model distinguishes missing navigation from pending and already-present element', () => {
  assert.equal(contextInitializationModel(callbacks).contextsAfterDocumentInserted, 0)
  assert.equal(contextInitializationModel(callbacks, { pendingNavigation: true }).contextsAfterDocumentInserted, 1)
  assert.equal(contextInitializationModel(callbacks, { elementAtGlobalClear: true }).contextsAfterDocumentInserted, 1)
})

test('model rejects incomplete sources instead of inventing vendor callbacks', () => {
  assert.throws(() => contextInitializationModel(''))
  assert.throws(() => contextInitializationModel(callbacks.replace('onWindowEvent(event)', 'anotherEvent(event)')))
})
