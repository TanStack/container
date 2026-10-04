import { chromium, firefox, webkit } from 'playwright'
import { writeFile } from 'node:fs/promises'
import { nativeTerminalFailureSnapshot, nativeTerminalViewport, renderedTerminalEdge, renderedTerminalScan } from './native-terminal-viewport.mjs'
import { browserErrorText } from './native-browser-diagnostic.mjs'

const site = process.env.NATIVE_SITE_ORIGIN ?? 'http://127.0.0.1:4198'
const preview = process.env.NATIVE_PREVIEW_ORIGIN ?? 'http://127.0.0.1:4199'
const engines = { chromium, firefox, webkit }
if (process.env.NATIVE_BROWSER && !Object.hasOwn(engines, process.env.NATIVE_BROWSER))
  throw Error('NATIVE_BROWSER must be chromium, firefox or webkit')
const repetitions = Number(process.env.NATIVE_EXAMPLE_REPETITIONS ?? 1)
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 10)
  throw Error('NATIVE_EXAMPLE_REPETITIONS must be an integer from 1 to 10')
const examples = [
  { id: 'start-counter', url: `${site}/start/latest/docs/framework/react/examples/start-counter?panel=playground`, before: 'Add 1 to', after: 'Terminal add 1 to' },
  { id: 'start-basic', url: `${site}/start/latest/docs/framework/react/examples/start-basic?panel=playground`, before: 'Welcome Home!!!', after: 'Terminal Home!!!' },
  { id: 'start-streaming-data-from-server-functions', url: `${site}/start/latest/docs/framework/react/examples/start-streaming-data-from-server-functions?panel=playground`, before: 'Typed Readable Stream', after: 'Terminal Typed Stream' },
  { id: 'basic-ssr-file-based', url: `${site}/router/latest/docs/framework/react/examples/basic-ssr-file-based?panel=playground`, before: 'Welcome Home!', after: 'Terminal Home!' },
]
const selectedExamples = process.env.NATIVE_EXAMPLES?.split(',')
if (selectedExamples?.some(id => !examples.some(example => example.id === id)))
  throw Error('NATIVE_EXAMPLES must contain known example IDs, separated by commas')
const plannedExamples = examples.filter(example => !selectedExamples || selectedExamples.includes(example.id))

for (const [browserName, engine] of Object.entries(engines)) {
  if (process.env.NATIVE_BROWSER && process.env.NATIVE_BROWSER !== browserName) continue
  const browser = await engine.launch({ headless: true })
  try {
    for (let repetition = 1; repetition <= repetitions; repetition++) for (const example of plannedExamples) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
      const diagnostics = []
      const previewEvents = []
      const lifecycleEvents = []
      let phase = 'startup'
      const started = Date.now()
      const record = event => {
        previewEvents.push({ elapsed: Date.now() - started, ...event })
        if (previewEvents.length > 150) previewEvents.shift()
      }
      const lifecycle = event => {
        lifecycleEvents.push({ elapsed: Date.now() - started, phase, ...event })
        if (lifecycleEvents.length > 200) lifecycleEvents.shift()
      }
      page.on('framenavigated', frame => {
        record({ type: 'navigation', url: frame.url() })
        lifecycle({ type: 'navigation', main: frame === page.mainFrame(), url: frame.url() })
      })
      page.on('framedetached', frame => {
        record({ type: 'detach', url: frame.url() })
        lifecycle({ type: 'detach', url: frame.url() })
      })
      page.on('request', request => {
        if (request.url().startsWith(site + '/__native-local/project.json'))
          lifecycle({ type: 'project request' })
        if (request.url().startsWith(site + '/') && request.isNavigationRequest() && request.frame() === page.mainFrame())
          lifecycle({ type: 'main document request', url: request.url() })
        if (request.url().startsWith(preview + '/'))
          record({ type: 'request', url: request.url(), document: request.isNavigationRequest() })
      })
      page.on('websocket', socket => {
        const url = new URL(socket.url())
        if (url.hostname !== '127.0.0.1' || url.port !== new URL(site).port) return
        socket.on('framereceived', ({ payload }) => {
          if (typeof payload !== 'string') return
          let message
          try { message = JSON.parse(payload) } catch { return }
          if (['full-reload', 'update', 'error'].includes(message.type))
            lifecycle({ type: 'site vite message', messageType: message.type })
        })
      })
      page.on('response', response => {
        if (response.url().startsWith(preview + '/'))
          record({ type: 'response', url: response.url(), status: response.status() })
      })
      page.on('requestfailed', request => {
        if (request.url().startsWith(preview + '/'))
          record({ type: 'failure', url: request.url(), error: request.failure()?.errorText })
      })
      page.on('pageerror', error => diagnostics.push(`page: ${browserErrorText(error)}`))
      page.on('console', message => {
        if (message.type() === 'error') diagnostics.push(`console: ${message.text()}`)
        const prefix = '[native-terminal-key] '
        if (message.text().startsWith(prefix)) lifecycle({ type: 'keyboard', ...JSON.parse(message.text().slice(prefix.length)) })
      })
      page.on('requestfailed', request => diagnostics.push(`request: ${request.url()} ${request.failure()?.errorText}`))
      await page.addInitScript(origin => {
        if (location.origin !== origin) return
        document.addEventListener('keydown', event => {
          if (event.key !== 'Enter' && !event.ctrlKey && !event.metaKey) return
          const active = document.activeElement
          console.log('[native-terminal-key] ' + JSON.stringify({ key: event.key,
            control: event.ctrlKey, meta: event.metaKey, alt: event.altKey,
            focusTag: active?.tagName, focusLabel: active?.getAttribute('aria-label'),
            focusRole: active?.getAttribute('role'), focusType: active?.getAttribute('type') }))
        }, true)
      }, site)
      try {
        await page.goto(example.url, { waitUntil: 'domcontentloaded', timeout: 120000 })
        await page.locator('[data-native-preview-ready="true"]').waitFor({ timeout: 180000 })
        const frame = page.frames().find(item => item.url() === `${preview}/`)
        if (!frame) throw Error(`${example.id}: preview frame did not open`)
        const body = await frame.locator('body').textContent()
        if (!body?.trim() || body.includes('Internal Server Error')) throw Error(`${example.id}: preview did not render: ${body}`)

        await page.getByRole('button', { name: 'Show terminal' }).click()
        await page.getByRole('button', { name: 'Terminal', exact: true }).click()
        const terminal = page.getByRole('region', { name: 'Sandbox terminal' })
        const input = terminal.locator('textarea[aria-label="Sandbox terminal"]')
        const virtualScrollback = async matches => {
          const view = nativeTerminalViewport(terminal, page)
          const result = await renderedTerminalScan(view, matches)
          await renderedTerminalEdge(view, 1)
          return result
        }
        const command = async (line, expected, timeout = 30000) => {
          phase = 'command: ' + line
          lifecycle({ type: 'command start' })
          await input.focus()
          const before = await terminal.locator('.xterm-rows').textContent()
          await page.keyboard.type(line)
          await page.keyboard.press('Enter')
          try {
            await page.waitForFunction(before => {
              const text = document.querySelector('[data-native-terminal] .xterm-rows')?.textContent ?? ''
              return text !== before && text.trimEnd().endsWith('project $')
            }, before, { timeout })
          } catch (error) {
            throw Error(`${browserName}: ${example.id} did not finish ${line}: ${JSON.stringify(await nativeTerminalFailureSnapshot(terminal, page))}`, { cause: error })
          }
          lifecycle({ type: 'command settled' })
          if ((await terminal.locator('.xterm-rows').textContent())?.includes(expected)) return
          if (await terminal.locator('.xterm-scrollable-element').count()) {
            const result = await virtualScrollback(text => text?.includes(expected))
            if (!result.found) throw Error(`${browserName}: ${example.id} did not show ${expected} after ${line}: ${result.screens.join('\n[scroll]\n')}`)
            return
          }
          const viewport = terminal.locator('.xterm-viewport')
          const height = await viewport.evaluate(element => element.scrollHeight)
          let found = false
          const screens = []
          for (let top = 0; top <= height; top += 24) {
            await viewport.evaluate((element, value) => { element.scrollTop = value }, top)
            await page.waitForTimeout(30)
            const text = await terminal.locator('.xterm-rows').textContent() ?? ''
            screens.push(text)
            if (text.includes(expected)) { found = true; break }
          }
          await viewport.evaluate((element, value) => { element.scrollTop = value }, height)
          if (!found) throw Error(`${browserName}: ${example.id} did not show ${expected} after ${line}: ${[...new Set(screens)].join('\n[scroll]\n')}`)
        }
        await command('pwd', '/project')
        await command('printf "terminal proof\\n" > terminal-proof.txt', 'project $')
        await command('cat terminal-proof.txt', 'terminal proof')
        const showFiles = page.getByRole('button', { name: 'Show files' })
        if (await showFiles.count()) await showFiles.click()
        await page.getByText('terminal-proof.txt', { exact: true }).first().click()
        const editor = page.getByRole('textbox', { name: 'Edit /terminal-proof.txt' })
        await editor.waitFor({ timeout: 30000 })
        const source = await editor.evaluate(element => element.cmTile.view.state.doc.toString())
        if (source !== 'terminal proof\n') throw Error(`${example.id}: editor did not see terminal write: ${source}`)
        if (frame.isDetached()) throw Error(`${example.id}: preview detached after terminal write`)
        if (!(await frame.locator('body').innerText()).includes(example.before))
          throw Error(`${example.id}: preview did not contain the expected source text before edit`)
        await command('cat src/routes/index.tsx', example.before)
        await command(`node -e 'console.log(require("node:fs").readFileSync("src/routes/index.tsx","utf8").includes(${JSON.stringify(example.before)}))'`, 'true')
        const patchSource = `const fs=require("node:fs");const p="src/routes/index.tsx";const s=fs.readFileSync(p,"utf8");if(!s.includes(${JSON.stringify(example.before)}))process.exit(2);fs.writeFileSync(p,s.replace(${JSON.stringify(example.before)},${JSON.stringify(example.after)}))`
        await command(`node -e '${patchSource}'`, 'project $')
        await command('cat src/routes/index.tsx', example.after)
        try { await page.frameLocator('iframe[title="Workspace preview"]').getByText(example.after, { exact: false }).waitFor({ timeout: 45000 }) }
        catch (error) { throw Error(`${example.id}: preview did not update: ${JSON.stringify({
          terminal: await terminal.locator('.xterm-rows').textContent({ timeout: 1000 }).catch(() => null),
          preview: await page.frameLocator('iframe[title="Workspace preview"]').locator('body').innerText({ timeout: 1000 }).catch(() => null),
          page: (await page.locator('body').innerText({ timeout: 1000 }).catch(() => '')).slice(-2000),
          diagnostics: diagnostics.slice(-20),
        })}`, { cause: error }) }
        await command('definitely-not-installed-command', 'Exited with code 127')
        await command('node -e "console.error(\'expected stderr\'); process.exitCode=7"', 'Exited with code 7')
        await input.focus()
        await page.keyboard.type('cat')
        await page.keyboard.press('Enter')
        await page.keyboard.type('hello from terminal')
        await page.keyboard.press('Enter')
        await page.waitForFunction(() => {
          const text = document.querySelector('[data-native-terminal] .xterm-rows')?.textContent ?? ''
          return text.split('hello from terminal').length >= 3
        }, undefined, { timeout: 10000 })
        await page.keyboard.press('Control+D')
        await page.waitForFunction(() => document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('project $'), undefined, { timeout: 10000 })
        await page.keyboard.type('sleep 10')
        await page.keyboard.press('Enter')
        await page.keyboard.press('Control+C')
        await page.waitForFunction(() => document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('project $'), undefined, { timeout: 10000 })
        await command('pwd', '/project')
        phase = 'production build'
        lifecycle({ type: 'build start' })
        await input.focus()
        await page.keyboard.press('Control+L')
        await page.keyboard.type('pnpm run build; printf "\\nBUILD_EXIT:%s\\n" "$?"')
        await page.keyboard.press('Enter')
        try {
          await page.waitForFunction(() => {
            const text = document.querySelector('[data-native-terminal] .xterm-rows')?.textContent ?? ''
            return text.trimEnd().endsWith('project $') &&
              /BUILD_EXIT:\d+/.test(text)
          }, undefined, { timeout: 180000 })
        } catch (error) {
          const snapshot = await nativeTerminalFailureSnapshot(terminal, page)
          throw Error(`${browserName}: ${example.id} build did not complete: ${JSON.stringify({snapshot,diagnostics:diagnostics.slice(-12)})}`,{cause:error})
        }
        lifecycle({ type: 'build settled' })
        if (await terminal.locator('.xterm-scrollable-element').count()) {
          const result = await virtualScrollback(text => text?.includes('BUILD_EXIT:0'))
          if (!result.found) throw Error(`${example.id}: build failed: ${result.screens.join('\n[scroll]\n').slice(-16000)}`)
        } else {
        const viewport = terminal.locator('.xterm-viewport')
        const height = await viewport.evaluate(element => element.scrollHeight)
        const buildScreens = []
        for (let top = 0; top <= height; top += 24) {
          await viewport.evaluate((element, value) => { element.scrollTop = value }, top)
          await page.waitForTimeout(30)
          const text = await terminal.locator('.xterm-rows').textContent() ?? ''
          buildScreens.push(text)
        }
        if (!buildScreens.some(text => text.includes('BUILD_EXIT:0')))
          throw Error(`${example.id}: build failed: ${[...new Set(buildScreens)].join('\n[scroll]\n').slice(-16000)}`)
        await viewport.evaluate((element, value) => { element.scrollTop = value }, height)
        }
        await command('pwd', '/project')
        if (frame.isDetached()) throw Error(`${example.id}: preview detached after build`)
        const separator = page.getByRole('separator', { name: 'Resize preview and terminal panels' })
        const originalSize = await separator.getAttribute('aria-valuenow')
        await separator.focus()
        await page.keyboard.press('ArrowUp')
        if (await separator.getAttribute('aria-valuenow') === originalSize)
          throw Error(`${example.id}: terminal panel did not resize`)
        await page.getByRole('button', { name: 'Hide terminal' }).click()
        await page.getByRole('button', { name: 'Show terminal' }).click()
        await command('cat terminal-proof.txt', 'terminal proof')
        const oldPreview = await page.locator('iframe[title="Workspace preview"]').elementHandle()
        if (!oldPreview) throw Error(`${example.id}: preview missing before restart`)
        await page.getByRole('button', { name: 'Run', exact: true }).click()
        await page.waitForFunction(element => !element.isConnected, oldPreview, { timeout: 30000 })
        try { await page.locator('[data-native-preview-ready="true"]').waitFor({ timeout: 180000 }) }
        catch (error) {
          throw Error(`${browserName}: ${example.id} preview did not restart: ${JSON.stringify({
            terminal:await terminal.locator('.xterm-rows').textContent({timeout:1000}).catch(()=>null),
            page:(await page.locator('body').innerText({timeout:1000}).catch(()=>'' )).slice(-3000),
            diagnostics:diagnostics.slice(-20),
          })}`,{cause:error})
        }
        await command('cat terminal-proof.txt', 'terminal proof')
        await page.frameLocator('iframe[title="Workspace preview"]').getByText(example.after, { exact: false }).waitFor({ timeout: 45000 })
        console.log(`${browserName}: ${example.id} run ${repetition}/${repetitions} terminal, input, interrupt, failures, editor, live preview edit, build, resize, reopen, restart passed`)
        console.log('NATIVE_TERMINAL_WORKFLOW_OBSERVATION ' + JSON.stringify({ browser: browserName, example: example.id, repetition, lifecycleEvents }))
      } catch (error) {
        const report = {
          browser: browserName, example: example.id, repetition,
          phase, error: browserErrorText(error),
          cause: error.cause ? browserErrorText(error.cause) : undefined,
          frames: page.frames().map(frame => ({ url: frame.url(), detached: frame.isDetached() })),
          page: (await page.locator('body').innerText({ timeout: 1000 }).catch(() => '')).slice(-4000),
          diagnostics: diagnostics.slice(-30),
          previewEvents,
          lifecycleEvents,
        }
        console.error(JSON.stringify(report, null, 2))
        if (process.env.NATIVE_FAILURE_REPORT)
          await writeFile(process.env.NATIVE_FAILURE_REPORT, JSON.stringify(report, null, 2), { flag: 'wx' })
        if (process.env.NATIVE_FAILURE_CAPTURE)
          await page.screenshot({ path: process.env.NATIVE_FAILURE_CAPTURE, fullPage: true }).catch(() => undefined)
        throw error
      } finally { await page.close() }
    }
  } finally { await browser.close() }
}
