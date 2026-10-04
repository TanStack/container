import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { chromium, firefox, webkit } from 'playwright'
import { readPinnedNativeExamples } from './native-example-sources.mjs'
import { diagnosticWithin } from './native-browser-diagnostic.mjs'

// The unchanged Start Counter, installed SDK and owner host, without the site
// layout, editor or xterm. Normal frame reads and clicks remain the pass gate.
const engines = { chromium, firefox, webkit }
assert.ok(!process.env.NATIVE_BROWSER || Object.hasOwn(engines, process.env.NATIVE_BROWSER), 'Unknown browser engine')
const repetitions = Number(process.env.NATIVE_RELOAD_REPETITIONS ?? 10)
assert.ok(Number.isSafeInteger(repetitions) && repetitions >= 1 && repetitions <= 50, 'NATIVE_RELOAD_REPETITIONS must be an integer from 1 to 50')
const writer = process.env.NATIVE_RELOAD_WRITER ?? 'terminal'
assert.ok(['terminal', 'owner'].includes(writer), 'NATIVE_RELOAD_WRITER must be terminal or owner')
const prelude = process.env.NATIVE_RELOAD_PRELUDE ?? 'none'
assert.ok(['none', 'background'].includes(prelude), 'NATIVE_RELOAD_PRELUDE must be none or background')
const origins = {
  site: process.env.NATIVE_SITE_ORIGIN ?? 'http://127.0.0.1:4308',
  owner: process.env.NATIVE_OWNER_ORIGIN ?? 'http://127.0.0.1:4307',
  preview: process.env.NATIVE_PREVIEW_ORIGIN ?? 'http://127.0.0.1:4309',
}
for (const origin of Object.values(origins)) {
  const url = new URL(origin)
  assert.equal(url.origin, origin, 'Use exact loopback origins')
  assert.equal(url.protocol, 'http:')
  assert.equal(url.hostname, '127.0.0.1')
}
assert.equal(new Set(Object.values(origins)).size, 3, 'Use separate site, owner and preview origins')
assert.ok(process.env.NATIVE_SDK_BUNDLE_DIR, 'Pass the installed consumer SDK directory')
assert.equal(basename(process.env.NATIVE_SDK_BUNDLE_DIR), 'browser-sandbox-experimental')
const buildId = createHash('sha256').update(await readFile(join(process.env.NATIVE_SDK_BUNDLE_DIR, 'package-assets.json'))).digest('hex')
const sources = readPinnedNativeExamples()
const example = sources.examples.get('react/start-counter')
const files = Object.fromEntries(Object.entries(example.files).map(([path, bytes]) => [path, typeof bytes === 'string' ? bytes : Array.from(bytes)]))

for (const [name, engine] of Object.entries(engines)) {
  if (process.env.NATIVE_BROWSER && process.env.NATIVE_BROWSER !== name) continue
  const browser = await engine.launch({ headless: true })
  const page = await browser.newPage()
  const errors = [], documents = [], navigations = [], failedModules = []
  let attempt = 0, phase = 'startup'
  page.on('pageerror', error => errors.push({ phase, error: String(error) }))
  page.on('console', message => {
    if (message.text().startsWith('[start-reload-control] ')) documents.push({ phase, text: message.text() })
  })
  page.on('framenavigated', frame => navigations.push({ phase, url: frame.url() }))
  page.on('response', response => {
    if (response.url().startsWith(origins.preview + '/') && response.status() >= 400)
      failedModules.push({ phase, url: response.url(), status: response.status() })
  })
  await page.addInitScript(previewOrigin => {
    if (location.origin !== previewOrigin) return
    console.log(`[start-reload-control] start ${performance.timeOrigin} ${location.href}`)
    addEventListener('pagehide', () => console.log(`[start-reload-control] pagehide ${performance.timeOrigin}`))
  }, origins.preview)
  let frame
  try {
    await page.goto(origins.site + '/')
    await page.evaluate(async ({ origins, files, buildId, writer, prelude }) => {
      const { NativeOwnerClient, URLPreview } = await import('/sdk/index.js')
      const ownerFrame = document.createElement('iframe')
      ownerFrame.allow = 'cross-origin-isolated'
      ownerFrame.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0'
      document.body.append(ownerFrame)
      const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { removeEventListener('message', listener); reject(Error('Owner frame did not load')) }, 15000)
        const listener = event => {
          if (event.source !== ownerFrame.contentWindow || event.origin !== origins.owner || event.data !== 'native-owner-ready') return
          clearTimeout(timer); removeEventListener('message', listener); resolve()
        }
        addEventListener('message', listener)
      })
      ownerFrame.src = origins.owner + '/owner.html'
      await ready
      const client = await NativeOwnerClient.connect(ownerFrame.contentWindow, origins.owner, origins.preview, { expectedBuildId: buildId })
      globalThis.startReloadControl = { client, ownerFrame }
      await client.start(Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, typeof bytes === 'string' ? bytes : new Uint8Array(bytes)])), {
        workspaceRoot: '/project', installCommand: 'pnpm install', startCommand: 'pnpm run dev',
      })
      const container = document.createElement('div')
      container.style.height = '500px'
      document.body.append(container)
      const preview = await URLPreview.mount(container, {
        origin: origins.preview,
        server: { fetch: request => client.fetch(request), revision: () => client.workspaceRevision() },
        connectWebSocket: (url, protocols) => client.connectWebSocket(origins.preview, url, protocols),
      })
      globalThis.startReloadControl.preview = preview
      if (writer === 'terminal' || prelude === 'background') globalThis.startReloadControl.session = await client.openTerminalSession()
    }, { origins, files, buildId, writer, prelude })
    frame = page.frames().find(frame => frame.url() === origins.preview + '/')
    assert.ok(frame, 'Start preview frame missing')
    await frame.getByRole('button', { name: 'Open TanStack Router Devtools' }).waitFor({ timeout: 45000 })
    await frame.getByRole('button', { name: 'Add 1 to 0?', exact: true }).click({ timeout: 45000 })
    await frame.getByRole('button', { name: 'Add 1 to 1?', exact: true }).waitFor({ timeout: 45000 })
    if (prelude === 'background') {
      phase = 'background-prelude'
      const result = await page.evaluate(async () => {
        const { session } = globalThis.startReloadControl
        const history = await session.runCommand('node -e \'for(let i=0;i<80;i++)console.log("HISTORY "+i)\'').result
        let background, timer
        let output = ''
        try {
          await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(Error('Background output did not arrive')), 30000)
            background = session.runCommand('node -e \'let i=0;setInterval(()=>console.log("BACKGROUND "+i++),30)\'', text => {
              output += text
              if (output.includes('BACKGROUND 30\n')) resolve()
            })
            background.result.then(() => reject(Error('Background process ended before interruption')), reject)
          })
        } finally {
          clearTimeout(timer)
          background?.interrupt()
        }
        const interrupted = await background.result
        const cwd = await session.runCommand('mkdir -p work && cd work && pwd').result
        return { history, interrupted, cwd }
      })
      assert.equal(result.history.exitCode, 0)
      assert.ok(result.history.stdout.includes('HISTORY 79'))
      assert.equal(result.interrupted.exitCode, 130)
      assert.equal(result.cwd.exitCode, 0)
      assert.equal(result.cwd.cwd, '/project/work')
      console.log(JSON.stringify({ browser: name, prelude, interrupted: result.interrupted.exitCode, cwd: result.cwd.cwd }))
    }
    for (attempt = 1; attempt <= repetitions; attempt++) {
      phase = `write-${attempt}`
      // Never match the outgoing document's previous mutation. Seeing this
      // distinct SSR value proves replacement before checking client hydration.
      const count = 40 + attempt * 10
      const result = await page.evaluate(async ({ writer, count, prelude }) => {
        const { client, session } = globalThis.startReloadControl
        if (writer === 'terminal') return await session.runCommand(prelude === 'background'
          ? `printf '${count}\\n' | cat > /project/count.txt`
          : `printf '${count}' > count.txt`).result
        await client.writeFile('/project/count.txt', String(count))
        return { exitCode: 0 }
      }, { writer, count, prelude })
      assert.equal(result.exitCode, 0)
      phase = `reload-${attempt}`
      await page.evaluate(() => globalThis.startReloadControl.preview.navigate('/'))
      await frame.getByRole('button', { name: `Add 1 to ${count}?`, exact: true }).waitFor({ timeout: 45000 })
      await frame.getByRole('button', { name: 'Open TanStack Router Devtools' }).waitFor({ timeout: 45000 })
      await frame.getByRole('button', { name: `Add 1 to ${count}?`, exact: true }).click({ timeout: 45000 })
      await frame.getByRole('button', { name: `Add 1 to ${count + 1}?`, exact: true }).waitFor({ timeout: 45000 })
      console.log(JSON.stringify({ browser: name, writer, prelude, reload: attempt, count: count + 1 }))
    }
    assert.deepEqual(errors, [], 'Preview page errors')
    assert.deepEqual(failedModules, [], 'Failed preview responses')
    console.log(JSON.stringify({ browser: name, writer, prelude, reloads: repetitions, passed: true, buildId,
      sourceSHA256: example.sourceSHA256, npmLockSHA256: example.npmLockSHA256,
      manifestSHA256: sources.manifestSHA256, documentStarts: documents.filter(entry => entry.text.includes(' start ')).length }))
  } catch (error) {
    const inspection = await diagnosticWithin(() => page.evaluate(() => globalThis.startReloadControl?.preview?.inspect()))
    const currentFrame = page.frames().find(candidate => candidate.url() === origins.preview + '/')
    const currentFrameRead = currentFrame ? await diagnosticWithin(() => currentFrame.evaluate(() => document.body.innerText)) : undefined
    const failure = { browser: name, writer, prelude, attempt, phase, error: String(error), buildId,
      sourceSHA256: example.sourceSHA256, npmLockSHA256: example.npmLockSHA256,
      retainedFrameDetached: frame?.isDetached(), sameCurrentFrame: currentFrame === frame,
      inspection, currentFrameRead, errors, documents, navigations, failedModules }
    console.error(JSON.stringify(failure))
    if (process.env.NATIVE_FAILURE_OUTPUT) await writeFile(process.env.NATIVE_FAILURE_OUTPUT, JSON.stringify(failure, null, 2))
    throw error
  } finally {
    await diagnosticWithin(() => page.evaluate(async () => {
      const control = globalThis.startReloadControl
      if (!control) return
      control.preview?.close()
      await control.session?.dispose()
      await control.client.dispose()
      control.client.close()
      control.ownerFrame.remove()
    }))
    await browser.close()
  }
}
