import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { chromium, firefox, webkit } from 'playwright'
import { diagnosticWithin } from './native-browser-diagnostic.mjs'

export function componentProbePlan(args, env = process.env) {
  assert.equal(args.length, 1, 'Pass the component-control identity.json')
  const receipt = resolve(args[0])
  assert.match(receipt, /^\/private\/tmp\/native-reload-components-[A-Za-z0-9]+\/identity\.json$/)
  const browsers = env.NATIVE_BROWSER ? [env.NATIVE_BROWSER] : ['chromium', 'firefox', 'webkit']
  assert.ok(browsers.every(name => ['chromium', 'firefox', 'webkit'].includes(name)))
  const runs = Number(env.NATIVE_COMPONENT_RUNS ?? 1)
  assert.ok(Number.isSafeInteger(runs) && runs >= 1 && runs <= 10, 'Use 1 to 10 component runs')
  return { receipt, browsers, runs }
}

export function validateComponentProbeMode(identity) {
  assert.equal(identity.mode ?? 'components', 'components',
    'Use test-local-native-terminal.mjs for the actual workbench host')
}

async function main() {
  const plan = componentProbePlan(process.argv.slice(2))
  const identity = JSON.parse(readFileSync(plan.receipt))
  validateComponentProbeMode(identity)
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  const runner = resolve(process.argv[1])
  const runnerSHA256 = hash(readFileSync(runner))
  const validate = () => {
    for (const component of Object.values(identity.components)) assert.equal(hash(readFileSync(component.path)), component.sha256)
    assert.equal(hash(readFileSync(join(identity.directory, 'client.tsx'))), identity.clientSHA256)
    assert.equal(hash(readFileSync(join(identity.sdk, 'package-assets.json'))), identity.acceptance.sdkManifestSHA256)
    assert.equal(hash(readFileSync(runner)), runnerSHA256, 'Probe source changed during the run')
  }
  validate()
  const report = { identity, runnerSHA256, browsers: plan.browsers, runs: plan.runs, rows: [], passed: false }
  const output = join(identity.directory, 'results-' + Date.now() + '.json')
  console.log('Component probe report: ' + output)
  for (let run = 1; run <= plan.runs; run++) for (const name of plan.browsers) {
    const browser = await { chromium, firefox, webkit }[name].launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const traces = [], errors = [], responses = []
    let phase = 'startup', frame
    const started = Date.now()
    const progress = setInterval(() => console.log(`${name} component run ${run}/${plan.runs}: ${phase}`), 10000)
    progress.unref()
    page.on('pageerror', error => errors.push({ phase, error: String(error) }))
    page.on('response', response => { if (response.url().startsWith(identity.preview + '/') && response.status() >= 400)
      responses.push({ phase, url: response.url(), status: response.status() }) })
    page.on('console', message => {
      if (message.text().startsWith('[component-document] ')) traces.push({ phase, text: message.text() })
    })
    await page.addInitScript(origin => {
      if (location.origin !== origin) return
      console.log('[component-document] start ' + performance.timeOrigin)
      addEventListener('pagehide', () => console.log('[component-document] pagehide ' + performance.timeOrigin))
    }, identity.preview)
    try {
      await page.goto(identity.site)
      await page.waitForFunction(() => document.querySelector('[data-ready="true"]') || document.querySelector('[role="alert"]'), undefined, { timeout: 180000 })
      assert.equal(await page.getByRole('alert').count(), 0, 'Component host startup failed: ' + (await page.getByRole('alert').allTextContents()).join('\n'))
      frame = page.frames().find(candidate => candidate.url() === identity.preview + '/')
      assert.ok(frame, 'Counter iframe missing')
      await frame.getByRole('button', { name: 'Open TanStack Router Devtools' }).waitFor({ timeout: 45000 })
      await frame.getByRole('button', { name: 'Add 1 to 0?', exact: true }).click({ timeout: 45000 })
      await frame.getByRole('button', { name: 'Add 1 to 1?', exact: true }).waitFor({ timeout: 45000 })
      await page.getByRole('button', { name: 'Show terminal', exact: true }).click()
      const input = page.getByRole('textbox', { name: 'Sandbox terminal', exact: true })
      const terminal = page.locator('[data-native-terminal] .xterm-rows')
      const waitPrompt = () => page.waitForFunction(() => document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('project $'), undefined, { timeout: 30000 })
      await waitPrompt()
      const command = async (line, expected) => {
        await input.focus(); await page.keyboard.type(line)
        // An outgoing prompt is not command completion. Wait until this new
        // command is actually rendered before looking for its following prompt.
        await page.waitForFunction(line => document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith(line.trimEnd()), line, { timeout: 5000 })
        await page.keyboard.press('Enter')
        await page.waitForFunction(expected => {
          const text = document.querySelector('[data-native-terminal] .xterm-rows')?.textContent ?? ''
          return text.includes(expected) && text.trimEnd().endsWith('project $')
        }, expected, { timeout: 30000 })
      }
      phase = 'terminal lifecycle'
      await command('TERMINAL_REOPENED=still-here', 'project $')
      await page.getByRole('button', { name: 'Hide terminal', exact: true }).click()
      assert.equal(await input.isVisible(), false)
      await page.getByRole('button', { name: 'Show terminal', exact: true }).click()
      await command('printf "REOPENED:%s\\n" "$TERMINAL_REOPENED"', 'REOPENED:still-here')
      phase = 'wrapped input'
      await input.focus(); await page.keyboard.type('echo ' + 'x'.repeat(100))
      for (const key of ['Home', 'End', 'ArrowLeft']) await page.keyboard.press(key)
      await page.keyboard.type('Y')
      await page.waitForFunction(() => document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.includes('Yx'), undefined, { timeout: 5000 })
      await page.keyboard.press('Enter'); await waitPrompt()
      phase = 'clear and word editing'
      await page.keyboard.type('echo before-clear'); await page.keyboard.press('Control+L')
      await page.waitForFunction(() => document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.includes('project $ echo before-clear'), undefined, { timeout: 5000 })
      await page.keyboard.press('Enter'); await waitPrompt()
      await page.keyboard.type('echo alpha beta   '); await page.keyboard.press('Control+W')
      await page.waitForFunction(() => document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('project $ echo alpha'), undefined, { timeout: 5000 })
      await page.keyboard.type('gamma'); await page.keyboard.press('Enter'); await waitPrompt()
      await page.keyboard.type('echo first second'); await page.keyboard.press('Alt+Backspace')
      await page.waitForFunction(() => document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('project $ echo first'), undefined, { timeout: 5000 })
      await page.keyboard.press('Control+C'); await waitPrompt()
      phase = 'resize'
      await command("printf 'SIZE1:'; stty size", 'SIZE1:')
      const before = /SIZE1:(\d+) (\d+)/.exec(await terminal.textContent())
      assert.ok(before, 'First child dimensions missing')
      const screenRowsBefore = await terminal.evaluate(element => element.children.length)
      const separator = page.getByRole('separator', { name: 'Resize preview and terminal panels' })
      await separator.click()
      await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'separator', undefined, { timeout: 5000 })
      for (let index = 0; index < 8; index++) await page.keyboard.press('ArrowUp')
      await page.waitForFunction(previous => document.querySelector('[data-native-terminal] .xterm-rows')?.children.length !== previous, screenRowsBefore, { timeout: 5000 })
      await command("printf 'SIZE2:'; stty size", 'SIZE2:')
      const after = /SIZE2:(\d+) (\d+)/.exec(await terminal.textContent())
      assert.ok(after, 'Resized child dimensions missing'); assert.notEqual(before[1], after[1])
      phase = 'scrollback and background interruption'
      await command('node -e \'for(let i=0;i<80;i++)console.log("HISTORY "+i)\'', 'HISTORY 79')
      await input.focus(); await page.keyboard.type('node -e \'let i=0;setInterval(()=>console.log("BACKGROUND "+i++),30)\'')
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.includes('BACKGROUND 30'), undefined, { timeout: 10000 })
      const viewport = page.locator('[data-native-terminal] .xterm-viewport')
      await viewport.evaluate(element => { element.scrollTop = 0 })
      await page.waitForTimeout(300)
      assert.equal(await viewport.evaluate(element => element.scrollTop), 0)
      await page.keyboard.press('Control+C'); await waitPrompt()
      const count = 40 + run * 10
      phase = 'write and reload'
      await command(`printf '${count}' > count.txt`, 'project $')
      await page.getByRole('button', { name: 'Reload preview', exact: true }).click()
      await frame.getByRole('button', { name: `Add 1 to ${count}?`, exact: true }).waitFor({ timeout: 45000 })
      await frame.getByRole('button', { name: 'Open TanStack Router Devtools' }).waitFor({ timeout: 45000 })
      await frame.getByRole('button', { name: `Add 1 to ${count}?`, exact: true }).click({ timeout: 45000 })
      await frame.getByRole('button', { name: `Add 1 to ${count + 1}?`, exact: true }).waitFor({ timeout: 45000 })
      phase = 'editor HMR and terminal synchronization'
      const original = await page.evaluate(() => window.reloadControl.readEntry())
      assert.equal(original.split('Add 1 to').length, 2)
      const editor = page.getByRole('textbox', { name: 'Edit /src/routes/index.tsx', exact: true })
      await editor.fill(original.replace('Add 1 to', 'Increment'))
      await page.evaluate(() => window.reloadControl.flushWrites())
      await frame.getByRole('button', { name: `Increment ${count + 1}?`, exact: true }).waitFor({ timeout: 45000 })
      await frame.getByRole('button', { name: `Increment ${count + 1}?`, exact: true }).click({ timeout: 45000 })
      await frame.getByRole('button', { name: `Increment ${count + 2}?`, exact: true }).waitFor({ timeout: 45000 })
      await command('cat src/routes/index.tsx', 'Increment')
      await editor.fill(original); await page.evaluate(() => window.reloadControl.flushWrites())
      await frame.getByRole('button', { name: `Add 1 to ${count + 2}?`, exact: true }).waitFor({ timeout: 45000 })
      assert.equal(await page.evaluate(() => window.reloadControl.readEntry()), original)
      const inspections = await page.evaluate(() => window.reloadControl.inspections)
      if (identity.inspect) assert.ok(inspections?.attempted > 0 && inspections?.succeeded > 0, 'Inspection case did not exercise successful polling')
      assert.deepEqual(errors, []); assert.deepEqual(responses, [])
      report.rows.push({ browser: name, version: browser.version(), run, passed: true,
        inspections, childSize: { before: before.slice(1), after: after.slice(1) }, documents: traces, elapsedMs: Date.now() - started })
    } catch (error) {
      const frameRead = frame ? await diagnosticWithin(() => frame.evaluate(() => document.body.innerText), 3000) : undefined
      const terminalState = await diagnosticWithin(() => page.evaluate(() => ({
        text: document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.slice(-4096),
        focus: { tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label') },
      })), 3000)
      const screenshot = join(identity.directory, `failure-${name}-${run}.png`)
      const capture = await diagnosticWithin(() => page.screenshot({ path: screenshot }), 3000)
      report.rows.push({ browser: name, version: browser.version(), run, passed: false, phase,
        error: String(error), frameRead, terminalState, screenshot: Buffer.isBuffer(capture) ? screenshot : undefined,
        errors, responses, documents: traces, elapsedMs: Date.now() - started })
    } finally { clearInterval(progress); await browser.close() }
    console.log(JSON.stringify(report.rows.at(-1)))
    validate()
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  }
  report.passed = report.rows.length === plan.runs * plan.browsers.length && report.rows.every(row => row.passed)
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  if (!report.passed) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
