import { createServer } from 'node:http'
import { createServer as createSecureServer } from 'node:https'
import { readFile } from 'node:fs/promises'

const host = process.env.SANDBOX_PREVIEW_HOST ?? '127.0.0.1'
const firstPort = Number(process.env.SANDBOX_PREVIEW_PORT ?? 4174)
if (!Number.isInteger(firstPort) || firstPort < 1024 || firstPort > 65534)
  throw new Error('Invalid preview port')
const cert = process.env.SANDBOX_TLS_CERT
const key = process.env.SANDBOX_TLS_KEY
if (Boolean(cert) !== Boolean(key))
  throw new Error('Provide both TLS certificate and key')
const tls =
  cert && key
    ? { cert: await readFile(cert), key: await readFile(key) }
    : undefined

// Static bootstrap only. Application requests must be answered by the service worker.
const assets = new Map(
  await Promise.all(
    ['bridge.html', 'bridge.js', 'sw.js', 'inspect.js', 'websocket.js'].map(async (name) => [
      '/__sandbox/' + name,
      {
        body: await readFile(
          new URL('../preview-host/' + name, import.meta.url),
        ),
        type: name.endsWith('.html') ? 'text/html' : 'text/javascript',
      },
    ]),
  ),
)
const requestPolicy=JSON.parse(await readFile(new URL('../src/sandbox/request-policy.json',import.meta.url),'utf8'))
assets.set('/__sandbox/request-policy.js',{body:`self.SANDBOX_REQUEST_TIMEOUT_MS=${JSON.stringify(requestPolicy.maxRequestTimeoutMs)};`,type:'text/javascript'})
for (const port of [firstPort, firstPort + 1]) {
  const handler = (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
    if (pathname === '/__sandbox/health') {
      response.end('ready')
      return
    }
    const asset = assets.get(pathname)
    if (!asset || request.method !== 'GET') {
      response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
      response.writeHead(503, { 'Content-Type': 'text/plain' })
      response.end('No browser workspace attached')
      return
    }
    response.setHeader('Content-Type', asset.type)
    response.setHeader('Service-Worker-Allowed', '/')
    if (pathname.endsWith('.html')) {
      response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
      response.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; worker-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'",
      )
    }
    response.end(asset.body)
  }
  const server = tls ? createSecureServer(tls, handler) : createServer(handler)
  server.listen(port, host, () =>
    console.log(
      `Preview bootstrap: ${tls ? 'https' : 'http'}://${host}:${port}`,
    ),
  )
}
