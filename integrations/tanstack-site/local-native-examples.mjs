import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Local fixture middleware, never mounted in the published SDK or production site.
export function localNativeExamples() {
  if (process.env.VITE_LOCAL_NATIVE_SANDBOX !== '1') return false
  const examples = new Set([
    'start-counter', 'start-basic',
    'start-streaming-data-from-server-functions', 'basic-ssr-file-based',
  ])
  return {
    name: 'local-native-examples',
    apply: 'serve',
    config(config) {
      // Fixtures can share installed dependencies, but not optimizer output
      // from hosts with different roots and SDK aliases.
      return { cacheDir: resolve(config.root ?? process.cwd(), '.native-local/vite-cache') }
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== '/__native-local/project.json') return next()
        response.setHeader('Cache-Control', 'no-store')
        response.setHeader('Content-Type', 'application/json')
        if (request.method !== 'GET') { response.statusCode = 405; response.end(); return }
        const example = url.searchParams.get('example')
        if (!examples.has(example)) { response.statusCode = 404; response.end(); return }
        response.end(readFileSync(resolve(server.config.root, '.native-local', example + '.json')))
      })
    },
  }
}
