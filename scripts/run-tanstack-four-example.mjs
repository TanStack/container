#!/usr/bin/env node
import { chromium, firefox, webkit } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  inspectSources,
  loadContract,
  validateContract,
  validateRunReport,
  validateSourceInspection,
} from '../integrations/tanstack-four-examples/harness.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}
const required = (name) => {
  const value = option(name)
  if (!value) throw new Error(`Missing ${name}`)
  return value
}
const runtime = required('--runtime')
const exampleId = required('--example')
const ownerUrl = required('--owner-url')
const outputPath = resolve(required('--out'))
const browserName = option('--browser', 'chromium')
const sourceRepository = resolve(option('--source-repository', '../router'))
const artifact = JSON.parse(readFileSync(resolve(required('--artifact-json')), 'utf8'))
const integration = JSON.parse(readFileSync(resolve(required('--integration-json')), 'utf8'))
const observedCommands = JSON.parse(
  readFileSync(resolve(required('--observed-commands-json')), 'utf8'),
)
const adaptations = option('--adaptations-json')
  ? JSON.parse(readFileSync(resolve(option('--adaptations-json')), 'utf8'))
  : []
const contract = validateContract(loadContract())
const example = contract.examples.find((item) => item.id === exampleId)
if (!example) throw new Error(`Unknown example: ${exampleId}`)
if (!contract.runtimes[runtime]) throw new Error(`Unknown runtime: ${runtime}`)
const browserType = { chromium, firefox, webkit }[browserName]
if (!browserType) throw new Error(`Unknown browser: ${browserName}`)

const sources = validateSourceInspection(
  inspectSources(sourceRepository, contract),
  contract,
)
const browser = await browserType.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
const startedAt = new Date().toISOString()
const clockStarted = performance.now()
const assertions = []
const pageErrors = []
const consoleErrors = []
const documentResponses = []
const failedResponses = []
const failedRequests = []
const events = []
const elapsed = () => Math.round((performance.now() - clockStarted) * 1000) / 1000
const documentText = (html) => html
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<script\b[\s\S]*?<\/script>/gi, '')
  .replace(/<style\b[\s\S]*?<\/style>/gi, '')
  .replace(/<[^>]+>/g, '')
  .replaceAll('&amp;', '&')
  .replaceAll('&lt;', '<')
  .replaceAll('&gt;', '>')
  .replaceAll('&quot;', '"')
  .replaceAll('&#39;', "'")
const event = (name, detail = {}) => events.push({ name, elapsedMs: elapsed(), ...detail })
const record = (id, result, detail = {}) => {
  assertions.push({ id, result, elapsedMs: elapsed(), ...detail })
  event(`assertion:${id}:${result}`)
}

page.on('pageerror', (error) => pageErrors.push(String(error)))
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('response', (response) => {
  if (response.status() >= 400) {
    const failed = {
      url: response.url(),
      status: response.status(),
      resourceType: response.request().resourceType(),
    }
    failedResponses.push(failed)
    void response.text().then(text => { failed.body = text.slice(0, 8000) }).catch(() => {})
  }
  if (response.request().resourceType() !== 'document') return
  void response
    .body()
    .then((body) => {
      documentResponses.push({
        url: response.url(),
        status: response.status(),
        headers: response.headers(),
        sha256: undefined,
        text: body.toString('utf8'),
      })
    })
    .catch(() => {})
})
page.on('requestfailed', (request) => {
  failedRequests.push({
    url: request.url(),
    resourceType: request.resourceType(),
    error: request.failure()?.errorText,
  })
})
await page.addInitScript(() => {
  if (window === top) return
  let bootstrap
  const sample = () => {
    if (window.$_TSR && typeof window.$_TSR.h === 'function') bootstrap = window.$_TSR
    window.__tanstackParityHydrated =
      bootstrap?.hydrated === true && bootstrap?.streamEnded === true
  }
  const observer = new MutationObserver(sample)
  observer.observe(document, { childList: true, subtree: true })
  const timer = setInterval(sample, 20)
  addEventListener('pagehide', () => {
    observer.disconnect()
    clearInterval(timer)
  }, { once: true })
  sample()
})

async function waitForPreview(text, timeout = 240_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue
      const body = await frame.locator('body').innerText({ timeout: 1_000 }).catch(() => '')
      if (body.includes(text)) return frame
    }
    const alert = page.getByRole('alert')
    if (await alert.count().catch(() => 0)) {
      const message = await alert.innerText().catch(() => '')
      if (message) throw new Error(message)
    }
    await page.waitForTimeout(100)
  }
  throw new Error(`No preview containing ${JSON.stringify(text)} within ${timeout}ms`)
}

async function waitForDocumentSSR(text, responseHeader) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const ownerOrigin = new URL(ownerUrl).origin
    const response = documentResponses.find(
      (item) => new URL(item.url).origin !== ownerOrigin &&
        (item.text.includes(text) || documentText(item.text).includes(text)),
    )
    if (response) {
      if (
        responseHeader &&
        response.headers[responseHeader.name.toLowerCase()] !== responseHeader.value
      ) {
        throw new Error(
          `SSR response header ${responseHeader.name} was ${JSON.stringify(response.headers[responseHeader.name.toLowerCase()])}, expected ${JSON.stringify(responseHeader.value)}`,
        )
      }
      return { url: response.url, status: response.status }
    }
    await page.waitForTimeout(50)
  }
  throw new Error(`No preview document response contained the SSR marker ${JSON.stringify(text)}`)
}

async function runAssertion(assertion, state) {
  if (assertion.kind === 'ssr-text') {
    state.preview = await waitForPreview(assertion.text)
    const response = await waitForDocumentSSR(assertion.text, assertion.responseHeader)
    return { marker: assertion.text, response }
  }
  if (assertion.kind === 'start-hydrated') {
    await state.preview.waitForFunction(
      () => window.__tanstackParityHydrated === true,
      undefined,
      { timeout: 90_000 },
    )
    return {}
  }
  if (assertion.kind === 'counter-increment') {
    await state.preview.getByRole('button', { name: assertion.from, exact: true }).click()
    await state.preview.getByRole('button', { name: assertion.to, exact: true }).waitFor({ timeout: 30_000 })
    return { from: assertion.from, to: assertion.to }
  }
  if (assertion.kind === 'png-asset') {
    const asset = await state.preview.evaluate(async (path) => {
      const response = await fetch(path)
      const bytes = new Uint8Array(await response.arrayBuffer())
      return {
        status: response.status,
        contentType: response.headers.get('content-type'),
        bytes: bytes.length,
        signature: [...bytes.slice(0, 8)],
      }
    }, assertion.path)
    const png = [137, 80, 78, 71, 13, 10, 26, 10]
    if (asset.status !== 200 || JSON.stringify(asset.signature) !== JSON.stringify(png)) {
      throw new Error(`Binary PNG was not preserved: ${JSON.stringify(asset)}`)
    }
    return asset
  }
  if (assertion.kind === 'deferred-route') {
    await state.preview.getByRole('link', { name: assertion.link, exact: true }).click()
    for (const text of assertion.expectedTexts) {
      await state.preview.getByText(text, { exact: false }).waitFor({ timeout: 30_000 })
    }
    await state.preview.getByRole('button', { name: 'Increment', exact: true }).click()
    await state.preview.getByText('Count: 1', { exact: true }).waitFor()
    await state.preview.getByRole('link', { name: 'Home', exact: true }).click()
    await state.preview.getByText('Welcome Home!!!', { exact: true }).waitFor()
    return { expectedTexts: assertion.expectedTexts }
  }
  if (assertion.kind === 'ten-stream-chunks') {
    await state.preview.getByRole('button', { name: assertion.button, exact: true }).click()
    const output = state.preview.locator('pre').nth(assertion.outputIndex)
    await output.waitFor()
    await output.evaluate(
      (element) =>
        new Promise((resolve, reject) => {
          const count = () => (element.textContent?.match(/Number #\d+:/g) ?? []).length
          if (count() === 10) return resolve(undefined)
          const observer = new MutationObserver(() => {
            if (count() === 10) {
              observer.disconnect()
              resolve(undefined)
            }
          })
          observer.observe(element, { childList: true, subtree: true, characterData: true })
          setTimeout(() => {
            observer.disconnect()
            reject(new Error(`Expected 10 chunks, received ${count()}`))
          }, 30_000)
        }),
    )
    return { chunks: 10 }
  }
  if (assertion.kind === 'router-navigation') {
    await state.preview.waitForFunction(
      () => Boolean(window.__TSR_ROUTER__) && performance.getEntriesByType('resource').some(
        entry => entry.name.includes('/src/routes/index.tsx') && entry.name.includes('tsr-split=component'),
      ),
      undefined,
      { timeout: 90_000 },
    )
    const timeOrigin = await state.preview.evaluate(() => performance.timeOrigin)
    await state.preview.getByRole('link', { name: assertion.link, exact: true }).click()
    await state.preview.getByText(assertion.expectedText, { exact: true }).waitFor({ timeout: 30_000 })
    const navigatedTimeOrigin = await state.preview.evaluate(() => performance.timeOrigin)
    if (navigatedTimeOrigin !== timeOrigin) throw new Error('Router link caused a document navigation before hydration')
    await state.preview.getByRole('link', { name: 'Home', exact: true }).click()
    await state.preview.getByText('Welcome Home!', { exact: true }).waitFor()
    if (await state.preview.evaluate(() => performance.timeOrigin) !== timeOrigin) {
      throw new Error('Router home link caused a document navigation')
    }
    return { link: assertion.link, expectedText: assertion.expectedText, documentNavigation: false }
  }
  if (assertion.kind === 'live-edit') {
    const sourcePath = resolve(
      sourceRepository,
      contract.source.root,
      example.sourcePath,
      assertion.path.replace(/^\//, ''),
    )
    const source = readFileSync(sourcePath, 'utf8')
    if (!source.includes(assertion.from)) throw new Error(`Live-edit marker changed in ${sourcePath}`)
    const editor = page.getByRole('textbox', { name: `Edit ${assertion.path}`, exact: true })
    await editor.waitFor({ state: 'visible', timeout: 30_000 })
    await editor.fill(source.replace(assertion.from, assertion.to))
    await state.preview.getByText(assertion.expectedText, { exact: true }).waitFor({ timeout: 30_000 })
    return { path: assertion.path, from: assertion.from, to: assertion.to }
  }
  throw new Error(`Unknown assertion kind: ${assertion.kind}`)
}

const report = {
  schemaVersion: 1,
  suiteId: contract.suiteId,
  runtime,
  exampleId,
  result: 'failed',
  startedAt,
  finishedAt: startedAt,
  browser: { name: browserName, version: browser.version() },
  source: {
    repository: contract.source.repository,
    revision: sources.revision,
    treeSHA256: sources.examples[exampleId].sha256,
    files: sources.examples[exampleId].files,
  },
  commands: example.commands,
  observedCommands,
  artifact,
  integration,
  adaptations,
  ownerUrl,
  assertions,
  events,
  diagnostics: { pageErrors, consoleErrors, failedResponses, failedRequests, documentResponses: [] },
}

const state = { preview: undefined }
try {
  const response = await page.goto(ownerUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  if (!response?.ok()) throw new Error(`Owner returned HTTP ${response?.status() ?? 'unknown'}`)
  event('owner-ready', { status: response.status() })
  if (runtime === 'sdk' && artifact.packaging === 'split') {
    const projectResponse = await page.request.get(new URL('/__sandbox-local/project.json', ownerUrl).href)
    if (!projectResponse.ok()) throw new Error('Cannot observe the owner asset identity')
    report.observedAssetIdentity = (await projectResponse.json()).identity
    for (const [observed, declared] of [['sdkManifestSHA256', 'manifestSHA256'], ['runtimeManifestSHA256', 'runtimeManifestSHA256'], ['deploymentManifestSHA256', 'deploymentManifestSHA256']]) {
      if (report.observedAssetIdentity?.[observed] !== artifact[declared]) throw new Error(`Owner asset identity mismatch: ${observed}`)
    }
  }
  const run = page.getByRole('button', { name: 'Run', exact: true })
  await run.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => undefined)
  if (await run.count()) {
    await run.click({ timeout: 30_000 })
    event('run-clicked')
  }
  for (const assertion of example.assertions) {
    try {
      record(assertion.id, 'passed', await runAssertion(assertion, state))
    } catch (error) {
      record(assertion.id, 'failed', { error: String(error) })
      throw error
    }
  }
  const navigationCancellations = pageErrors.filter((error) => {
    const url = /^TypeError: error loading dynamically imported module: (https?:\/\/\S+)$/.exec(error)?.[1]
    return url && failedRequests.some(request => request.url === url && request.error === 'NS_BINDING_ABORTED')
  })
  report.diagnostics.navigationCancellations = navigationCancellations
  const fatalPageErrors = pageErrors.filter(error => !navigationCancellations.includes(error))
  report.diagnostics.pageErrors = fatalPageErrors
  const coepBlockedRequests = failedRequests.filter(request =>
    request.error?.includes('ERR_BLOCKED_BY_RESPONSE.NotSameOriginAfterDefaultedToSameOriginByCoep'),
  )
  const scarfBlockedByCoep = coepBlockedRequests.length > 0 &&
    coepBlockedRequests.every(request => request.url.startsWith('https://static.scarf.sh/'))
  const ownerResourceBlocks = consoleErrors.filter(error =>
    (error.includes('static.scarf.sh/') &&
      failedRequests.some(request => request.url.startsWith('https://static.scarf.sh/'))) ||
    (scarfBlockedByCoep &&
      error.includes('ERR_BLOCKED_BY_RESPONSE.NotSameOriginAfterDefaultedToSameOriginByCoep')),
  )
  report.diagnostics.ownerResourceBlocks = ownerResourceBlocks
  const fatalConsoleErrors = consoleErrors.filter(error => !ownerResourceBlocks.includes(error))
  report.diagnostics.consoleErrors = fatalConsoleErrors
  if (fatalPageErrors.length || fatalConsoleErrors.length) {
    throw new Error(`Browser errors observed: ${JSON.stringify({ pageErrors: fatalPageErrors, consoleErrors: fatalConsoleErrors })}`)
  }
  report.result = 'passed'
} catch (error) {
  report.error = String(error)
  report.diagnostics.ownerText = (await page.locator('body').innerText().catch(() => '')).slice(-64_000)
  if (state.preview) {
    report.diagnostics.previewUrl = state.preview.url()
    report.diagnostics.previewText = (await state.preview.locator('body').innerText().catch(() => '')).slice(-64_000)
    report.diagnostics.editedModule = await state.preview.evaluate(async () => {
      const response = await fetch('/src/routes/index.tsx')
      return { status: response.status, text: (await response.text()).slice(-64_000) }
    }).catch(error => ({ error: String(error) }))
    report.diagnostics.viteClient = await state.preview.evaluate(async () => {
      const response = await fetch('/@vite/client')
      const text = await response.text()
      return {
        status: response.status,
        websocket: text.match(/const socketHost = ([^;]+);/)?.[0],
        token: text.match(/const wsToken = ([^;]+);/)?.[0],
        directTarget: text.match(/const directSocketHost = ([^;]+);/)?.[0],
      }
    }).catch(error => ({ error: String(error) }))
  }
} finally {
  report.finishedAt = new Date().toISOString()
  report.diagnostics.documentResponses = documentResponses.map(({ text, ...item }) => ({
    ...item,
    markers: example.assertions
      .filter((assertion) => assertion.kind === 'ssr-text' &&
        (text.includes(assertion.text) || documentText(text).includes(assertion.text)))
      .map((assertion) => assertion.text),
  }))
  await browser.close()
  validateRunReport(report, contract)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${report.result.toUpperCase()} ${runtime} ${exampleId}: ${outputPath}\n`)
  if (report.result !== 'passed') process.exitCode = 1
}
