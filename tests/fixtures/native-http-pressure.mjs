export function createNativeHTTPPressureServer(createServer, observe = () => {}) {
  const bytes = 300 * 1024
  const received = new Set(), finished = new Set(), held = new Set()
  const state = () => ({received: received.size, finished: finished.size, held: held.size})
  const server = createServer((request, response) => {
    const path = request.url
    if (path === '/') { response.end('ok'); return }
    received.add(path)
    if (received.size % 32 === 0) observe({phase: 'received', count: received.size})
    if (path.startsWith('/hold/')) { held.add(path); observe({phase: 'held-request', ...state()}); return }
    const index = Number(path.slice('/module/'.length))
    const body = new Uint8Array(bytes).fill(index % 251)
    response.setHeader('Content-Type', 'application/javascript')
    response.setHeader('Content-Length', String(body.length))
    response.on('finish', () => { finished.add(path); if (finished.size % 32 === 0) observe({phase: 'finished', count: finished.size, ...state()}) })
    response.end(body)
  })
  return {server, state}
}

// Shared workload for real Node HTTP and the browser's guest HTTP implementation.
export async function probeNativeHTTPPressure(createServer, fetchRequest, observe = () => {}) {
  const consumed = new Set()
  const {server, state} = createNativeHTTPPressureServer(createServer, observe)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  observe({phase: 'listening'})
  const waitFor = async (predicate, label) => {
    const deadline = performance.now() + 5000
    while (!predicate()) {
      if (performance.now() >= deadline) throw Error(label)
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
  const controllers = Array.from({length: 32}, () => new AbortController())
  const reasons = controllers.map((_, index) => Error('Cancelled held request ' + index))
  const requests = controllers.map((controller, index) => new Request(origin + '/hold/' + index,
    {signal: controller.signal}))
  const old = requests.map((request, index) => fetchRequest(request)
    .then(() => ({unexpectedResponse: true}), error => ({sameReason: error === reasons[index]})))
  try {
    await waitFor(() => state().held === 32, 'Held requests did not reach the HTTP server')
    observe({phase: 'held', count: state().held})
    // More than the 32-slot browser HTTP capacity. New requests wait behind old
    // requests, then must make progress through that same pool after cancellation.
    const modules = Array.from({length: 96}, async (_, index) => {
      const response = await fetchRequest(new Request(origin + '/module/' + index))
      // Delay some consumers so a large response has genuine socket backpressure.
      if (index % 4 === 0) await new Promise(resolve => setTimeout(resolve, 20))
      const body = new Uint8Array(await response.arrayBuffer())
      consumed.add(index)
      if (consumed.size % 32 === 0) observe({phase: 'body-consumed', count: consumed.size})
      const value = index % 251
      return {index, status: response.status, length: body.length,
        bytesMatch: body.every(byte => byte === value)}
    })
    for (const [index, controller] of controllers.entries()) controller.abort(reasons[index])
    const abortedSignals = requests.filter(request => request.signal.aborted).length
    observe({phase: 'aborted', signals: abortedSignals})
    if (abortedSignals !== requests.length) throw Error('Request cancellation did not propagate from its controller')
    const cancelled = await Promise.all(old)
    observe({phase: 'cancelled', count: cancelled.length})
    const responses = await Promise.all(modules)
    observe({phase: 'consumed', count: responses.length})
    await waitFor(() => state().finished === 96, 'Responses did not finish on the HTTP server')
    return {cancelled, responses, ...state()}
  } finally {
    observe({phase: 'cleanup', ...state()})
    for (const [index, controller] of controllers.entries()) controller.abort(reasons[index])
    await Promise.all(old)
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    observe({phase: 'closed'})
  }
}
