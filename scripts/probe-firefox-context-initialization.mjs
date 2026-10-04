import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'

// A model of vendor callbacks, not a browser test or a shipping patch.
// Reads the installed vendor source without editing the browser archive.
// Use trusted installed archives only, this VM is a harness, not a security boundary.
export function contextInitializationModel(source, { pendingNavigation = false, elementAtGlobalClear = false } = {}) {
  const methods = {}
  for (const name of ['_onGlobalObjectCleared', '_initializeExecutionContexts', '_frameNavigationCommitted', 'onWindowEvent']) {
    const match = source.match(new RegExp('^  ' + name + '\\([^\\n]*\\) \\{\\r?\\n[\\s\\S]*?^  \\}', 'm'))
    if (!match) {
      assert.equal(name, '_initializeExecutionContexts', 'Vendor callback missing: ' + name)
      continue
    }
    const object = runInNewContext('({' + match[0] + '})', {
      FrameTree: { Events: { NavigationCommitted: 'navigation-committed' } },
      Ci: { nsIWebNavigation: {} }, dump() {},
    }, { timeout: 1000 })
    methods[name] = object[name]
  }
  const events = []
  let phase = 'global-clear', nextContext = 0
  const docShell = { currentURI: { spec: 'http://127.0.0.1:4199/' }, QueryInterface() {} }
  const domWindow = { windowGlobalChild: { innerWindowId: 2 },
    location: { href: 'http://127.0.0.1:4199/' },
    document: { documentElement: elementAtGlobalClear ? {} : undefined } }
  const frame = {
    _frameId: 'preview', _children: [],
    _pendingNavigationId: pendingNavigation ? 'navigation-1' : undefined,
    _worldNameToContext: new Map([['', { id: 'old' }]]),
    _runtime: {
      destroyExecutionContext(context) { events.push({ phase, type: 'context-destroyed', id: context.id }) },
      createExecutionContext() {
        const context = { id: 'new-' + ++nextContext }
        events.push({ phase, type: 'context-created', id: context.id })
        return context
      },
    },
    domWindow() { return domWindow },
    _updateJavaScriptDisabled() {},
    ...(methods._initializeExecutionContexts ? { _initializeExecutionContexts: methods._initializeExecutionContexts } : {}),
  }
  const tree = {
    _webSocketEventService: { hasListenerFor() { return false }, addListener() {} },
    _isolatedWorlds: new Map(),
    emit(type) { events.push({ phase, type }) },
    frameForDocShell(value) { assert.equal(value, docShell); return frame },
    _frameNavigationCommitted: methods._frameNavigationCommitted,
  }
  frame._frameTree = tree
  const invoke = (callback, receiver, args = []) => runInNewContext('__callback.apply(__receiver, __args)',
    { __callback: callback, __receiver: receiver, __args: args }, { timeout: 1000 })
  invoke(methods._onGlobalObjectCleared, frame)
  const contextsAfterGlobalClear = frame._worldNameToContext.size
  domWindow.document.documentElement = {}
  phase = 'document-element-inserted'
  // Older and newer versions use different names for the document's global.
  const target = { ownerGlobal: { docShell }, documentGlobal: { docShell } }
  invoke(methods.onWindowEvent, tree, [{ type: 'DOMDocElementInserted', target }])
  return { pendingNavigation, elementAtGlobalClear, contextsAfterGlobalClear,
    contextsAfterDocumentInserted: frame._worldNameToContext.size, events }
}

async function main() {
  assert.ok(process.argv.length >= 3, 'Pass one or more installed Firefox omni.ja archives')
  for (const argument of process.argv.slice(2)) {
    const archive = await realpath(argument)
    assert.equal(basename(archive), 'omni.ja')
    assert.ok((await stat(archive)).isFile())
    const source = execFileSync('unzip', ['-p', archive, 'chrome/juggler/content/content/FrameTree.js'],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 })
    console.log(JSON.stringify({ archive, sourceSHA256: createHash('sha256').update(source).digest('hex'),
      evidence: 'vendor-callback-model-not-browser-execution',
      cases: [contextInitializationModel(source),
        contextInitializationModel(source, { pendingNavigation: true }),
        contextInitializationModel(source, { elementAtGlobalClear: true })],
    }, null, 2))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
