import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {chromium, firefox, webkit} from '@playwright/test'
import {probeNativeHTTPPressure} from './fixtures/native-http-pressure.mjs'

test('guest HTTP handles queued large responses after cancellation in each desktop browser', {
  skip: process.env.NATIVE_HTTP_PRESSURE_CONTROL !== '1' ? 'Opt-in real HTTP pressure control' : false,
  timeout: 60000,
}, async () => {
  const root = resolve(process.env.NATIVE_SOURCE_ROOT ?? process.cwd())
  const require = createRequire(resolve(root, 'package.json'))
  const {build} = require('esbuild')
  const expected = await probeNativeHTTPPressure(createServer, request => fetch(request),
    event => console.log('HTTP_PRESSURE_NODE ' + JSON.stringify(event)))
  assert.equal(expected.received, 128)
  assert.equal(expected.finished, 96)
  assert.ok(expected.cancelled.every(result => result.sameReason))
  assert.ok(expected.responses.every(result => result.status === 200 && result.length === 300 * 1024 && result.bytesMatch))
  const bundle = await build({stdin: {resolveDir: root, contents: `
    import './src/vite-browser/runtime-host';
    import {createServer} from './src/sandbox/guest-http.js';
    import {connectVirtual,network} from './src/vite-browser/runtime-network';
    import {WorkerHTTP} from './src/sandbox/worker-http';
    import {probeNativeHTTPPressure} from './tests/fixtures/native-http-pressure.mjs';
    self.onmessage=async()=>{
      try {
        const kernel={connect:connectVirtual};
        const result=await probeNativeHTTPPressure(createServer,request=>new WorkerHTTP(kernel,Number(new URL(request.url).port)).fetch(request),
          event=>self.postMessage({progress:event}));
        self.postMessage({result,handles:network.size});
      }catch(error){self.postMessage({error:String(error),stack:error.stack,handles:network.snapshot()})}
    };
  `}, bundle: true, write: false, format: 'esm', platform: 'browser', loader: {'.wasm': 'binary'},
    alias: Object.fromEntries([
      ['node:stream', require.resolve('stream-browserify')],
      ['node:events', require.resolve('events/')],
      ['node:buffer', require.resolve('buffer/')],
      ['node:process', require.resolve('process/browser')],
      ['node:net', resolve(root, 'src/sandbox/guest-net.js')],
      ['process/browser', require.resolve('process/browser')],
      ['process', require.resolve('process/browser')],
    ]),
  })
  const app = createServer((_request, response) => {
    response.writeHead(200, {'Content-Type': 'text/html',
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp'})
    response.end('<!doctype html><title>HTTP pressure control</title>')
  })
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve))
  try { for (const engine of [chromium, firefox, webkit]) {
    const browser = await engine.launch()
    try {
      const page = await browser.newPage()
      page.on('console', message => console.log(engine.name() + ' ' + message.text()))
      await page.goto('http://127.0.0.1:' + app.address().port)
      const actual = await page.evaluate(async source => {
        const url = URL.createObjectURL(new Blob([source], {type: 'text/javascript'}))
        const worker = new Worker(url, {type: 'module'})
        try {
          return await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(Error('HTTP pressure worker did not settle')), 15000)
            worker.onmessage = event => {
              if(event.data.progress){console.log('HTTP_PRESSURE_BROWSER '+JSON.stringify(event.data.progress));return}
              clearTimeout(timeout); resolve(event.data)
            }
            worker.onerror = event => { clearTimeout(timeout); reject(Error(event.message || 'Worker bootstrap failed at ' + event.filename)) }
            worker.postMessage({run: true})
          })
        } finally { worker.terminate(); URL.revokeObjectURL(url) }
      }, bundle.outputFiles[0].text)
      assert.equal(actual.error, undefined, engine.name() + ': ' + JSON.stringify(actual))
      assert.deepEqual(actual.result, expected, engine.name())
      assert.equal(actual.handles, 0, engine.name() + ' virtual sockets must close')
      console.log(JSON.stringify({browser: engine.name(), version: browser.version(),
        held: 32, completed: 96, responseBytes: 300 * 1024, handles: actual.handles, passed: true}))
    } finally { await browser.close() }
  } } finally { await new Promise(resolve => app.close(resolve)) }
})
