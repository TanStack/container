import { defineConfig, loadEnv } from 'vite'
import { readFileSync } from 'node:fs'

const tlsCert = process.env.SANDBOX_TLS_CERT
const tlsKey = process.env.SANDBOX_TLS_KEY
const testOptimization = process.env.WASM_TEST_OPT
const testSyncOptimization = process.env.QJS_TEST_OPT
const testCooperative = process.env.TERMINATION_COOPERATIVE === '1'
const cooperativeBatch = process.env.COOPERATIVE_WASM_BATCH
const cooperativeOptimization = process.env.COOPERATIVE_WASM_OPT ?? 'o2'
if(!['o2','o3'].includes(cooperativeOptimization))throw Error('Unsupported COOPERATIVE_WASM_OPT')
if(cooperativeOptimization!=='o2'&&!testCooperative)throw Error('COOPERATIVE_WASM_OPT requires cooperative candidate')
const assignmentParser = process.env.COOPERATIVE_ASSIGNMENTS === '1'
const dispatchUnwind = process.env.COOPERATIVE_UNWIND === '1'
const heapLoops = process.env.COOPERATIVE_HEAP_LOOPS === '1'
if(heapLoops&&!dispatchUnwind)throw Error('Heap loops require dispatch unwind')
if(dispatchUnwind&&!testCooperative)throw Error('COOPERATIVE_UNWIND requires cooperative candidate')
if(assignmentParser&&!testCooperative)throw Error('COOPERATIVE_ASSIGNMENTS requires cooperative candidate')
if (cooperativeBatch && (!testCooperative || !['16','32'].includes(cooperativeBatch))) throw Error('Unsupported COOPERATIVE_WASM_BATCH')
if (cooperativeBatch === '32' && process.env.COOPERATIVE_UNWIND !== '1') throw Error('Batch 32 requires dispatch unwind')
if (testSyncOptimization && !['o2','o2-vm-modules'].includes(testSyncOptimization)) throw Error('Unsupported QJS_TEST_OPT')
if (testOptimization && !['o2','o2-vm-modules','o2-trampoline','o2-poll4096-trampoline','o2-poll4096-trampoline-batch16'].includes(testOptimization)) throw Error('Unsupported WASM_TEST_OPT')
if (Boolean(tlsCert) !== Boolean(tlsKey))
  throw new Error('Provide both SANDBOX_TLS_CERT and SANDBOX_TLS_KEY')
const https =
  tlsCert && tlsKey
    ? { cert: readFileSync(tlsCert), key: readFileSync(tlsKey) }
    : undefined

const headers =
  loadEnv('development', '.', 'SANDBOX_').SANDBOX_CROSS_ORIGIN_ISOLATED === '1'
    ? {
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Opener-Policy': 'same-origin',
      }
    : {}

export default defineConfig({
  plugins: testOptimization || testSyncOptimization || testCooperative ? [{
    name: 'test-wasm-engine-variant',
    configureServer(server) {
      const variants = [['quickjs-als-wasm', testOptimization], ['quickjs-als', testSyncOptimization]].filter(([,variant])=>variant)
      const assets = new Map(variants.flatMap(([base,variant])=>['core.mjs', 'engine.mjs', 'engine.wasm'].map(name =>
        ['/'+base+'/' + name, readFileSync(`public/${base}-${variant}/${name}`)] as const)))
      if(testCooperative)for(const wasm of ['', '-wasm']){
        const base='quickjs-als-asyncify'+wasm
        const candidate=base+'-'+(wasm?cooperativeOptimization:'o2')+'-generator-queue-yield-profile'+(wasm?'-poll4096':'')+'-cooperative'+(wasm&&cooperativeBatch?'-batch'+cooperativeBatch:'')+(wasm&&assignmentParser?'-assignments':'')+(wasm&&dispatchUnwind?'-unwind':'')+(wasm&&heapLoops?'-heap-loops':'')
        for(const name of ['core.mjs','engine.mjs','engine.wasm','ffi.mjs'])assets.set('/'+base+'-cooperative/'+name,readFileSync(`public/${candidate}/${name}`))
      }
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split('?')[0] ?? ''
        const body = assets.get(path)
        if (!body) return next()
        response.setHeader('Content-Type', path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
        response.setHeader('X-Sandbox-Engine-Variant', testCooperative?'termination-cooperative':testOptimization ?? testSyncOptimization!)
        response.setHeader('Cache-Control', 'no-store')
        response.end(body)
      })
    },
  }] : [],
  optimizeDeps: {
    // The optional VM is loaded inside a worker, beyond the HTML dependency scan.
    include: [
      'quickjs-emscripten-core',
      'cjs-module-lexer',
      'whatwg-url',
      'esbuild-wasm',
      'sha.js',
      'minimatch',
      'semver',
      '@jitl/quickjs-wasmfile-release-sync',
      '@jitl/quickjs-wasmfile-release-asyncify',
      '@jitl/quickjs-wasmfile-release-sync/ffi',
      '@jitl/quickjs-wasmfile-release-sync/emscripten-module',
    ],
  },
  build: {
    rollupOptions: { input: { main: 'index.html', sandbox: 'sandbox.html' } },
  },
  worker: { format: 'es' },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
  },
  server: {
    headers,
    https,
  },
  preview: {
    headers,
  },
})
