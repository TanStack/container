const MAX_BODY = 16 * 1024 * 1024
const clientRequests = new Map()
const supersededClients = new Set()
const supersededOrder = []
function supersedeClient(clientId) {
  if (!clientId) return
  if (!supersededClients.has(clientId)) {
    supersededClients.add(clientId)
    supersededOrder.push(clientId)
    if (supersededOrder.length > 64)
      supersededClients.delete(supersededOrder.shift())
  }
  for (const cancel of clientRequests.get(clientId) ?? [])
    cancel(new Error('Workspace request superseded by navigation'))
}
function trackClientRequest(clientId, cancel) {
  if (!clientId) return { release() {}, superseded: false }
  if (supersededClients.has(clientId)) return { release() {}, superseded: true }
  let requests = clientRequests.get(clientId)
  if (!requests) clientRequests.set(clientId, requests = new Set())
  requests.add(cancel)
  return {
    superseded: false,
    release() {
      requests.delete(cancel)
      if (!requests.size) clientRequests.delete(clientId)
    },
  }
}
importScripts('/__sandbox/request-policy.js')
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()))
self.addEventListener('activate', (event) =>
  event.waitUntil(self.clients.claim()),
)
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'claim-workspace-bridge' || !event.source?.url) return
  const source = new URL(event.source.url)
  if (source.origin !== self.location.origin || source.pathname !== '/__sandbox/bridge.html') return
  event.waitUntil(self.clients.claim())
})
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/__sandbox/')
  )
    return
  event.respondWith(route(event).then((response) => {
    // Hosting headers do not apply to responses synthesized by a service worker.
    // Keep every workspace document compatible with an isolated owner, including
    // redirects and error responses, without trusting guest response headers.
    const headers = new Headers(response.headers)
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp')
    if(event.request.mode === 'navigate')headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
    return new Response(response.body, {status: response.status, statusText: response.statusText, headers})
  }))
})
async function route(event) {
  const request = event.request
  try {
    const source = event.clientId
      ? await self.clients.get(event.clientId)
      : undefined
    const sourceOrigin = source ? new URL(source.url).origin : undefined
    if (request.mode !== 'navigate' && sourceOrigin !== self.location.origin)
      return new Response('Cross-origin workspace request denied', {
        status: 403,
      })
    if (
      !['GET', 'HEAD'].includes(request.method) &&
      sourceOrigin !== self.location.origin
    )
      return new Response('Unverified workspace request origin', {
        status: 403,
      })
    const headers = new Headers(request.headers)
    // Fetch metadata is normally added at the network layer, after interception.
    // Derive it from the browser-owned client, never from guest-supplied headers.
    headers.set(
      'Sec-Fetch-Site',
      sourceOrigin === self.location.origin
        ? 'same-origin'
        : sourceOrigin
          ? 'cross-site'
          : 'none',
    )
    if (sourceOrigin) headers.set('Origin', sourceOrigin)
    // Discover the owner for each request. No routing state is lost when this worker sleeps.
    const clients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    })
    if (request.mode === 'navigate') {
      const replaced = typeof event.replacesClientId === 'string'
        ? event.replacesClientId
        : ''
      if (replaced) supersedeClient(replaced)
    } else {
      // Firefox and WebKit do not currently expose replacesClientId. Once a
      // replacement document makes its first request, the replaced client is
      // absent from matchAll. Cancel only requests whose owning client is
      // demonstrably gone, never another live tab or the current requester.
      const live = new Set(clients.map(client => client.id).filter(Boolean))
      for (const clientId of clientRequests.keys())
        if (clientId !== event.clientId && !live.has(clientId))
          supersedeClient(clientId)
    }
    const bridges = clients.filter(
      (client) => new URL(client.url).pathname === '/__sandbox/bridge.html',
    )
    if (bridges.length !== 1)
      return new Response('Expected exactly one workspace owner', {
        status: 503,
      })
    const body = ['GET', 'HEAD'].includes(request.method)
      ? undefined
      : await request.arrayBuffer()
    if (body?.byteLength > MAX_BODY)
      return new Response('Request too large', { status: 413 })
    const result = await new Promise((resolve, reject) => {
      const channel = new MessageChannel()
      let settled = false
      let timer
      let releaseClientRequest = () => {}
      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        releaseClientRequest()
        request.signal.removeEventListener('abort', abort)
        channel.port1.close()
        if (error) reject(error)
        else resolve(value)
      }
      const cancel = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        releaseClientRequest()
        request.signal.removeEventListener('abort', abort)
        channel.port1.onmessage = () => channel.port1.close()
        channel.port1.postMessage({type:'cancel'})
        setTimeout(() => channel.port1.close(), 1000)
        reject(error)
      }
      const abort = () => cancel(request.signal.reason ?? new Error('Workspace request cancelled'))
      timer = setTimeout(() => cancel(new Error('Workspace request timed out')), self.SANDBOX_REQUEST_TIMEOUT_MS)
      channel.port1.onmessage = (event) => finish(undefined, event.data)
      request.signal.addEventListener('abort', abort, {once:true})
      if (request.signal.aborted) {
        abort()
        channel.port2.close()
        return
      }
      const tracked = trackClientRequest(
        request.mode === 'navigate' || request.keepalive ? '' : event.clientId,
        cancel,
      )
      releaseClientRequest = tracked.release
      if (tracked.superseded) {
        cancel(new Error('Workspace request superseded by navigation'))
        channel.port2.close()
        return
      }
      try {
        bridges[0].postMessage(
          {
            type: 'request',
            url: request.url,
            method: request.method,
            // Browser-owned navigation metadata, not request headers or guest data.
            navigation: {
              mode: request.mode,
              destination: request.destination,
              resultingClientId: event.resultingClientId,
            },
            headers: [...headers],
            body,
          },
          [channel.port2],
        )
      } catch (error) {
        channel.port2.close()
        finish(error)
      }
    })
    if (result.error) throw new Error(result.error)
    if (result.body?.byteLength > MAX_BODY)
      throw new Error('Response too large')
    return new Response(
      request.method === 'HEAD' || [204, 205, 304].includes(result.status)
        ? null
        : result.body,
      { status: result.status, headers: result.headers },
    )
  } catch (error) {
    return new Response(String(error), {
      status: 502,
      headers: { 'Content-Type': 'text/plain' },
    })
  }
}
