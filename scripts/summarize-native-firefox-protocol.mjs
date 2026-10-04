import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

// Keep lifecycle evidence, not evaluated scripts, request headers or cookies.
// Absence in a bounded log is evidence about that captured interval only.
export function summarizeFirefoxProtocol(log) {
  const lifecycle = []
  const browserDiagnostics = []
  let parsed = 0, malformed = 0
  for (const rawLine of log.split('\n')) {
    const line = rawLine.replace(/\x1b\[[0-9;]*m/g, '')
    // Classify browser stderr without copying stacks, app data or scripts.
    // A category is evidence of a logged error, not a diagnosis of its cause.
    if (line.includes('pw:browser') && line.includes('[err]')) {
      const categories = [
        ['juggler-simple-channel-redeclaration', /chrome:\/\/juggler\/content\/SimpleChannel\.js.*redeclaration of let SimpleChannel/],
        ['juggler-progress-listener-failure', /NS_ERROR_FAILURE.*chrome:\/\/juggler\/content\/Helper\.js.*removeProgressListener/],
        ['javascript-timeout', /Script terminated by timeout/],
        ['wasm-compiler-unavailable', /no WebAssembly compiler available/],
      ]
      for (const [category, pattern] of categories)
        if (pattern.test(line)) browserDiagnostics.push({ time: /^\d{4}-\d{2}-\d{2}T\S+/.exec(line)?.[0], category })
    }
    const marker = line.indexOf('◀ RECV ')
    if (marker < 0) continue
    let message
    try { message = JSON.parse(line.slice(marker + '◀ RECV '.length).replace(/\x1b\[[0-9;]*m/g, '')) }
    catch { malformed++; continue }
    parsed++
    const p = message.params ?? {}
    const common = { time: line.slice(0, 24), sessionId: message.sessionId, method: message.method }
    if (['Page.navigationStarted', 'Page.navigationCommitted', 'Page.navigationAborted', 'Page.sameDocumentNavigation', 'Page.frameAttached', 'Page.frameDetached', 'Page.eventFired'].includes(message.method))
      lifecycle.push({ ...common, frameId: p.frameId, parentFrameId: p.parentFrameId,
        url: p.url, event: p.name, navigationId: p.navigationId })
    if (message.method === 'Runtime.executionContextCreated')
      lifecycle.push({ ...common, executionContextId: p.executionContextId, frameId: p.auxData?.frameId, world: p.auxData?.name })
    if (['Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared'].includes(message.method))
      lifecycle.push({ ...common, executionContextId: p.executionContextId })
    if (message.method === 'Runtime.console') {
      const text = p.args?.find(arg => typeof arg.value === 'string' && arg.value.startsWith('[terminal-document] '))?.value
      if (text) lifecycle.push({ ...common, executionContextId: p.executionContextId, trace: text })
    }
  }
  return { parsedInboundMessages: parsed, malformedInboundLines: malformed, lifecycle, browserDiagnostics }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw Error('Pass one captured Firefox protocol log')
  console.log(JSON.stringify(summarizeFirefoxProtocol(await readFile(process.argv[2], 'utf8')), null, 2))
}
