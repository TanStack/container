import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { chromium, firefox, webkit } from 'playwright'
import { diagnosticWithin } from './native-browser-diagnostic.mjs'

// Isolate URLPreview navigation from Vite, React, the shell and site layout.
// Failure diagnostics never replace the normal frame and click assertions.
assert.ok(process.env.NATIVE_SDK_BUNDLE_DIR, 'Pass NATIVE_SDK_BUNDLE_DIR from the installed consumer')
assert.ok(!process.env.NATIVE_BROWSER || ['chromium', 'firefox', 'webkit'].includes(process.env.NATIVE_BROWSER), 'Unknown browser engine')
const sdk = await realpath(process.env.NATIVE_SDK_BUNDLE_DIR)
assert.equal(path.basename(sdk), 'browser-sandbox-experimental', 'Pass the installed SDK directory')
const bundle = path.join(sdk, 'index.js')
assert.ok((await stat(bundle)).isFile())
const previewOrigin = process.env.NATIVE_PREVIEW_ORIGIN ?? 'http://127.0.0.1:4199'
assert.equal(new URL(previewOrigin).hostname, '127.0.0.1')
assert.equal(new URL(previewOrigin).origin, previewOrigin, 'Pass an exact loopback preview origin')
const repetitions = Number(process.env.NATIVE_RELOAD_REPETITIONS ?? 20)
assert.ok(Number.isSafeInteger(repetitions) && repetitions >= 1 && repetitions <= 50)
const host = createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
  response.setHeader('Cache-Control', 'no-store')
  try {
    if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html')
      response.end('<!doctype html><title>Preview reload control</title><div id="preview" style="height:400px"></div>')
    } else if (request.url === '/sdk/index.js') {
      response.setHeader('Content-Type', 'text/javascript')
      response.end(await readFile(bundle))
    } else response.writeHead(404).end()
  } catch { response.writeHead(500).end() }
})
await new Promise((resolve, reject) => {
  host.once('error', reject)
  host.listen(0, '127.0.0.1', resolve)
})
const origin = `http://127.0.0.1:${host.address().port}`
try {
  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    if (process.env.NATIVE_BROWSER && process.env.NATIVE_BROWSER !== name) continue
    const browser = await engine.launch({ headless: true })
    const page = await browser.newPage()
    const errors = []
    const documents = []
    page.on('pageerror', error => errors.push(String(error)))
    page.on('console', message => {
      if (message.text().startsWith('[reload-control] ')) documents.push(message.text())
    })
    await page.addInitScript(({ previewOrigin }) => {
      if (location.origin !== previewOrigin) return
      console.log(`[reload-control] ${performance.timeOrigin} ${location.href}`)
    }, { previewOrigin })
    try {
      await page.goto(origin)
      await page.evaluate(async previewOrigin => {
        const { URLPreview } = await import('/sdk/index.js')
        const html = '<!doctype html><html><head><title>Counter control</title></head><body><button onclick="this.textContent=String(Number(this.textContent)+1)">0</button></body></html>'
        globalThis.reloadControl = await URLPreview.mount(document.querySelector('#preview'), {
          origin: previewOrigin,
          server: { async fetch() { return new Response(html, { headers: { 'Content-Type': 'text/html' } }) } },
        })
      }, previewOrigin)
      const frame = page.frames().find(frame => frame.url() === previewOrigin + '/')
      assert.ok(frame)
      for (let attempt = 0; attempt <= repetitions; attempt++) {
        if (attempt) {
          await page.evaluate(toggle => {
            const preview = globalThis.reloadControl
            if (toggle) { preview.frame.style.display = 'none'; preview.frame.style.display = '' }
            preview.navigate('/')
          }, process.env.NATIVE_RELOAD_TOGGLE === '1')
        }
        try {
          await frame.getByRole('button', { name: '0', exact: true }).waitFor({ timeout: 5000 })
          await frame.getByRole('button', { name: '0', exact: true }).click({ timeout: 5000 })
          await frame.getByRole('button', { name: '1', exact: true }).waitFor({ timeout: 5000 })
        } catch (error) {
          const inspection = await diagnosticWithin(() => page.evaluate(() => globalThis.reloadControl.inspect()))
          const inspectionClick = await diagnosticWithin(() => page.evaluate(() => globalThis.reloadControl.click('button')))
          console.error(JSON.stringify({ browser: name, attempt, error: String(error), inspection, inspectionClick, documents, errors }))
          throw error
        }
      }
      assert.deepEqual(errors, [])
      console.log(JSON.stringify({ browser: name, reloads: repetitions, frameReadsAndClicks: true, documents: documents.length, errors }))
    } finally { await browser.close() }
  }
} finally { await new Promise(resolve => host.close(resolve)) }
