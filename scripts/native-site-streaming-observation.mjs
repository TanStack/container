import assert from 'node:assert/strict'

// Observes preview traffic only. No request headers, bodies or query values.
export function observePreviewNetwork(page, { previewOrigin, phase, maxEvents = 256, now = Date.now }) {
  const origin = new URL(previewOrigin).origin
  assert.equal(previewOrigin, origin)
  assert.equal(typeof phase, 'function')
  assert.equal(typeof now, 'function')
  assert.ok(Number.isSafeInteger(maxEvents) && maxEvents >= 1 && maxEvents <= 512)
  const start = now(), events = [], listeners = []
  let dropped = 0
  const record = (kind, request, extra = {}) => {
    let url
    try { url = new URL(request.url()) } catch { return }
    if (url.origin !== origin) return
    const event = { kind, elapsedMs: Math.max(0, now() - start), phase: phase(),
      method: request.method(), url: origin + url.pathname,
      queryKeys: [...new Set(url.searchParams.keys())], ...extra }
    events.push(event)
    if (events.length > maxEvents) { events.shift(); dropped++ }
  }
  const on = (name, callback) => { page.on(name, callback); listeners.push([name, callback]) }
  on('request', request => record('request', request))
  on('response', response => record('response', response.request(), { status: response.status() }))
  on('requestfinished', request => {
    const timing = request.timing()
    record('finished', request, { responseStartMs: timing.responseStart, responseEndMs: timing.responseEnd })
  })
  on('requestfailed', request => record('failed', request, { error: String(request.failure()?.errorText ?? '').slice(0, 500) }))
  return {
    snapshot: () => ({ dropped, events: events.map(event => ({ ...event, queryKeys: [...event.queryKeys] })) }),
    stop: () => { for (const [name, callback] of listeners) page.off(name, callback) },
  }
}

export function streamedNumberObservation(text, elapsedMs) {
  assert.equal(typeof text, 'string')
  assert.ok(Number.isFinite(elapsedMs) && elapsedMs >= 0)
  const numbers = [...text.matchAll(/Number #(\d+):/g)].map(match => Number(match[1]))
  return { elapsedMs, characters: text.length, numbers }
}
