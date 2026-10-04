import { chromium, firefox, webkit } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { unexpectedPreviewErrors } from './native-preview-navigation-errors.mjs'
import { browserErrorText, diagnosticWithin } from './native-browser-diagnostic.mjs'
import { observePreviewNetwork, streamedNumberObservation } from './native-site-streaming-observation.mjs'
import { waitForPinnedStartClient } from './native-start-example-readiness.mjs'

const siteOrigin = process.env.NATIVE_SITE_ORIGIN ?? 'http://127.0.0.1:4198'
const previewOrigin = process.env.NATIVE_PREVIEW_ORIGIN ?? 'http://127.0.0.1:4199'
const url = `${siteOrigin}/start/latest/docs/framework/react/examples/start-counter?panel=playground`
const browserTypes = { chromium, firefox, webkit }
const browserName = process.env.NATIVE_TEST_BROWSER ?? 'chromium'
const browserType = browserTypes[browserName]
if (!browserType) throw Error(`Unsupported browser: ${browserName}`)
const browser = await browserType.launch({ headless: true })
const page = await browser.newPage()
const errors = []
const failedPreviewResponses = []
const failedPreviewRequests = []
const documentTraces = []
const previewRequests = []
const interactionTrace = []
let phase = 'counter startup'
let streamingPage
let streamingNetwork
const streamingObservations = []
page.on('request', request => {
  if(request.url().startsWith(previewOrigin+'/'))previewRequests.push({phase,method:request.method(),url:request.url()})
})
if (process.env.LOCAL_NATIVE_STREAM_ONLY !== '1') {
  page.on('console', message => {
    if (message.text().startsWith('[native-document]'))
      documentTraces.push(`${phase}: ${message.text()}`)
  })
  await page.addInitScript(({ previewOrigin }) => {
    if (location.origin !== previewOrigin) return
    const id = `${performance.timeOrigin}-${Math.random().toString(36).slice(2)}`
    globalThis.__nativeDocumentId = id
    console.log(`[native-document] start ${id} ${location.href}`)
    addEventListener('pagehide', () => console.log(`[native-document] pagehide ${id}`))
    addEventListener('error', event => console.log(`[native-document] error ${id} ${event.message}`))
    addEventListener('unhandledrejection', event =>
      console.log(`[native-document] rejection ${id} ${String(event.reason)}`))
  }, { previewOrigin })
}
page.on('pageerror', error => errors.push(`${phase}: ${browserErrorText(error)}`))
const recordPreviewResponse = response => {
  if (response.url().startsWith(previewOrigin + '/') && response.status() >= 400)
    failedPreviewResponses.push(`${phase}: HTTP ${response.status()} ${response.url()}`)
}
page.on('response', recordPreviewResponse)
const recordPreviewFailure = request => {
  if (request.url().startsWith(previewOrigin + '/')) {
    let frame = 'unknown'
    try { frame = `detached=${request.frame().isDetached()},url=${request.frame().url()}` } catch {}
    failedPreviewRequests.push(`${phase}: ${JSON.stringify(request.failure())} ${frame} ${request.url()}`)
  }
}
page.on('requestfailed', recordPreviewFailure)
function assertNoUnexpectedErrors() {
  const unexpected = unexpectedPreviewErrors(errors, documentTraces, failedPreviewRequests)
  if (unexpected.length || failedPreviewResponses.length)
    throw Error('Page errors: ' + unexpected.join('; ') + '\nPreview responses: ' +
      failedPreviewResponses.join('; ') + '\nFailed preview requests: ' + failedPreviewRequests.join('; ') +
      '\nDocument traces: ' + documentTraces.slice(-60).join('; '))
}
async function assertIsolation(response, document) {
  if (!response || response.headers()['cross-origin-embedder-policy'] !== 'require-corp')
    throw Error(`${browserName}: native example did not select require-corp headers`)
  const isolated = await document.evaluate(() => isSecureContext && crossOriginIsolated)
  if (!isolated) throw Error(`${browserName}: native example document is not cross-origin isolated`)
}

async function previewDocument(frame, expectedText, express = false) {
  const document = await frame.evaluate(async () => {
    const response = await fetch('/')
    return { status: response.status, contentType: response.headers.get('content-type'),
      poweredBy: response.headers.get('x-powered-by'), html: await response.text() }
  })
  if (document.status !== 200 || !document.contentType?.includes('text/html') || !document.html.includes(expectedText))
    throw Error(`${browserName}: preview SSR response failed: ${JSON.stringify({ ...document, html: document.html.slice(0, 400) })}`)
  if (express && document.poweredBy !== 'Express') throw Error(`${browserName}: Router SSR did not preserve the Express response header`)
}

async function previewIdentity(frame) {
  const identity = await frame.evaluate(() => ({ id: globalThis.__nativeDocumentId, timeOrigin: performance.timeOrigin }))
  if (typeof identity.id !== 'string' || !identity.id) throw Error('Preview document identity is missing')
  return identity
}

async function assertSamePreviewDocument(frame, before, example) {
  const after = await previewIdentity(frame)
  console.log('NATIVE_SITE_NAVIGATION ' + JSON.stringify({ browser: browserName, example, before, after }))
  if (after.id !== before.id) throw Error(`${example} navigation reloaded the preview document`)
}

async function checkBasicAndRouter() {
  phase = 'basic startup'
  await assertIsolation(await page.goto(`${siteOrigin}/start/latest/docs/framework/react/examples/start-basic?panel=playground`,
    { waitUntil: 'domcontentloaded', timeout: 120000 }), page)
  await page.locator('[data-native-preview-ready="true"]').waitFor({ timeout: 180000 })
  let frame = page.frames().find(item => item.url() === `${previewOrigin}/`)
  if (!frame) throw Error('Basic preview frame did not open')
  await frame.getByRole('heading', { name: 'Welcome Home!!!', exact: true }).waitFor({ timeout: 30000 })
  await waitForPinnedStartClient(frame)
  await previewDocument(frame, 'Welcome Home!!!')

  phase = 'basic binary asset'
  const asset = await frame.evaluate(async () => {
    const response = await fetch('/favicon-32x32.png')
    const bytes = new Uint8Array(await response.arrayBuffer())
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return { status: response.status, contentType: response.headers.get('content-type'), bytes: bytes.length,
      sha256: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') }
  })
  if (asset.status !== 200 || !asset.contentType?.includes('image/png') ||
    asset.sha256 !== '340aad7ef0dcd643bb891b52ef64507d79821ef402e2d2d8003a130eda5ddba2')
    throw Error(`${browserName}: Basic binary asset differs from the pinned source: ${JSON.stringify(asset)}`)

  phase = 'basic deferred server functions'
  const basicDocument = await previewIdentity(frame)
  await frame.getByRole('link', { name: 'Deferred', exact: true }).click()
  await frame.getByTestId('regular-person').filter({ hasText: 'John Doe' }).waitFor({ timeout: 30000 })
  await frame.getByTestId('deferred-person').filter({ hasText: 'Tanner Linsley' }).waitFor({ timeout: 30000 })
  await frame.getByTestId('deferred-stuff').filter({ hasText: 'Hello deferred!' }).waitFor({ timeout: 30000 })
  await frame.getByText('Count: 0', { exact: true }).waitFor({ timeout: 30000 })
  await frame.getByRole('button', { name: 'Increment', exact: true }).click()
  await frame.getByText('Count: 1', { exact: true }).waitFor({ timeout: 30000 })
  await frame.getByRole('link', { name: 'Home', exact: true }).click()
  await frame.getByRole('heading', { name: 'Welcome Home!!!', exact: true }).waitFor({ timeout: 30000 })
  await assertSamePreviewDocument(frame, basicDocument, 'Basic')

  phase = 'basic live edit'
  let editor = page.getByRole('textbox', { name: 'Edit /src/routes/index.tsx' })
  let source = await editor.evaluate(element => element.cmTile.view.state.doc.toString())
  if (source.split('Welcome Home!!!').length !== 2) throw Error('Basic source edit anchor differs')
  await editor.fill(source.replace('Welcome Home!!!', 'Site Basic edit passed'))
  await frame.getByRole('heading', { name: 'Site Basic edit passed', exact: true }).waitFor({ timeout: 45000 })
  assertNoUnexpectedErrors()
  console.log(`${browserName}: Basic SSR, binary asset, deferred server functions, hydration, navigation and live edit passed`)

  phase = 'router startup'
  await assertIsolation(await page.goto(`${siteOrigin}/router/latest/docs/framework/react/examples/basic-ssr-file-based?panel=playground`,
    { waitUntil: 'domcontentloaded', timeout: 120000 }), page)
  await page.locator('[data-native-preview-ready="true"]').waitFor({ timeout: 180000 })
  frame = page.frames().find(item => item.url() === `${previewOrigin}/`)
  if (!frame) throw Error('Router preview frame did not open')
  await frame.getByRole('heading', { name: 'Welcome Home!', exact: true }).waitFor({ timeout: 30000 })
  await waitForPinnedStartClient(frame)
  await previewDocument(frame, 'Welcome Home!', true)

  phase = 'router post navigation'
  const routerDocument = await previewIdentity(frame)
  await frame.getByRole('link', { name: 'Posts', exact: true }).click()
  await frame.getByText('Select a post.', { exact: true }).waitFor({ timeout: 45000 })
  await frame.locator('a[href="/posts/1"]').click()
  await frame.getByRole('heading', { name: 'Comments', exact: true }).waitFor({ timeout: 45000 })
  await frame.getByRole('link', { name: 'Home', exact: true }).click()
  await frame.getByRole('heading', { name: 'Welcome Home!', exact: true }).waitFor({ timeout: 30000 })
  await assertSamePreviewDocument(frame, routerDocument, 'Router')

  phase = 'router live edit'
  editor = page.getByRole('textbox', { name: 'Edit /src/routes/index.tsx' })
  source = await editor.evaluate(element => element.cmTile.view.state.doc.toString())
  if (source.split('Welcome Home!').length !== 2) throw Error('Router source edit anchor differs')
  await editor.fill(source.replace('Welcome Home!', 'Site Router edit passed'))
  await frame.getByRole('heading', { name: 'Site Router edit passed', exact: true }).waitFor({ timeout: 45000 })
  assertNoUnexpectedErrors()
  console.log(`${browserName}: Router Express SSR, hydration, post navigation and live edit passed`)
}
try {
  if (process.env.LOCAL_NATIVE_STREAM_ONLY !== '1') {
  await assertIsolation(await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 }), page)
  await page.locator('[data-native-boot-overlay] [role="status"]').waitFor({ timeout: 30000 })
  if (await page.locator('[data-native-preview-ready] > header [role="status"]').count()) throw Error('Startup phase is still in the workbench header')
  if (process.env.LOCAL_NATIVE_BOOT_CAPTURE) {
    await page.waitForTimeout(1500)
    if (await page.locator('[data-native-boot-overlay]').count()) await page.screenshot({ path: process.env.LOCAL_NATIVE_BOOT_CAPTURE, fullPage: true })
  }
  await page.locator('[data-native-preview-ready="true"]').waitFor({ timeout: 180000 })
  if (await page.locator('[data-native-boot-overlay]').count()) throw Error('Startup overlay remained visible after preview became ready')
  let frame = page.frames().find(item => item.url() === `${previewOrigin}/`)
  if (!frame) throw Error('Preview frame did not open')
  await frame.getByRole('button', { name: 'Add 1 to 0?' }).waitFor({ timeout: 30000 })
  // This pinned example mounts its devtools control in a React effect.
  // Network idle can precede hydration for service-worker responses.
  // Wait for the existing client UI, not framework internals or a fixed delay.
  await waitForPinnedStartClient(frame)
  if(process.env.LOCAL_NATIVE_TRACE_INTERACTION==='1')interactionTrace.push({stage:'before first click',state:await frame.evaluate(()=>{
    const button=document.querySelector('button')
    return {readyState:document.readyState,text:button?.textContent,bindingKeys:Object.keys(button??{}).filter(key=>key.startsWith('__react')),resourceCount:performance.getEntriesByType('resource').length,time:performance.now()}
  })})
  await frame.getByRole('button', { name: 'Add 1 to 0?' }).click()
  await frame.getByRole('button', { name: 'Add 1 to 1?' }).waitFor({ timeout: 30000 })
  console.log(`${browserName}: Counter click passed`)
  if (process.env.LOCAL_NATIVE_RELOAD_STRESS) {
    const count = Number(process.env.LOCAL_NATIVE_RELOAD_STRESS)
    if (!Number.isSafeInteger(count) || count < 1 || count > 20) throw Error('Invalid reload stress count')
    for (let attempt = 1; attempt <= count; attempt++) {
      phase = `counter reload ${attempt}`
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.locator('[data-native-preview-ready="true"]').waitFor({ timeout: 180000 })
      frame = page.frames().find(item => item.url() === `${previewOrigin}/`)
      if (!frame) throw Error(`Reload ${attempt} did not open a preview frame`)
      await frame.getByRole('button', { name: 'Add 1 to 0?' }).waitFor({ timeout: 45000 })
      const documentId = process.env.LOCAL_NATIVE_TRACE_DOCUMENTS === '1'
        ? await frame.evaluate(() => globalThis.__nativeDocumentId) : undefined
      console.log(`Reload ${attempt} passed${documentId ? `, document ${documentId}` : ''}`)
    }
    assertNoUnexpectedErrors()
  } else {

  phase = 'counter live edit'
  const editor = page.getByRole('textbox', { name: 'Edit /src/routes/index.tsx' })
  const source = await editor.evaluate(element => element.cmTile.view.state.doc.toString())
  if (!source.includes('Add 1 to')) throw Error('Counter source is missing')
  await editor.fill(source.replace('Add 1 to', 'Add one to'))
  await frame.getByRole('button', { name: /Add one to/ }).waitFor({ timeout: 45000 })
  console.log(`${browserName}: Live edit passed`)

  if (await page.getByRole('button', { name: 'Save', exact: true }).count()) throw Error('Save is still visible')
  if (await page.getByRole('button', { name: 'Resume', exact: true }).count()) throw Error('Resume is still visible')
  if (await page.getByRole('button', { name: 'Stop', exact: true }).count()) throw Error('Stop is still visible')
  if (process.env.LOCAL_NATIVE_STEADY_ONLY !== '1') {
  phase = 'counter Run restart'
  const oldPreviewFrame = await page.locator('iframe[title="Workspace preview"]').elementHandle()
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await page.waitForFunction(frame => !frame.isConnected, oldPreviewFrame, { timeout: 30000 })
  await page.locator('[data-native-preview-ready="true"]').waitFor({ timeout: 180000 })
  frame = page.frames().find(item => item.url() === `${previewOrigin}/`)
  if (!frame) throw Error('Restarted preview frame did not open')
  await frame.getByRole('button', { name: /Add one to/ }).waitFor({ timeout: 45000 })
  console.log(`${browserName}: Run restarted edited app`)
  phase = 'counter page reload'
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('[data-native-preview-ready="true"]').waitFor({ timeout: 180000 })
  frame = page.frames().find(item => item.url() === `${previewOrigin}/`)
  if (!frame) throw Error('Reloaded preview frame did not open')
  await frame.getByRole('button', { name: 'Add 1 to 0?' }).waitFor({ timeout: 45000 })
  await waitForPinnedStartClient(frame)
  console.log(`${browserName}: Reload started a fresh example`)
  }
  }
  }
  if (process.env.LOCAL_NATIVE_COUNTER_ONLY === '1') {
    assertNoUnexpectedErrors()
    process.exitCode = 0
  } else {
  if (process.env.LOCAL_NATIVE_STREAM_ONLY !== '1') await checkBasicAndRouter()
  phase = 'streaming startup'
  streamingPage = await browser.newPage()
  if (process.env.LOCAL_NATIVE_TRACE_STREAMING === '1')
    streamingNetwork = observePreviewNetwork(streamingPage, { previewOrigin, phase: () => phase })
  streamingPage.on('request', request => {
    if (request.url().startsWith(previewOrigin + '/')) previewRequests.push({ phase, method: request.method(), url: request.url() })
  })
  streamingPage.on('pageerror', error => errors.push(`${phase}: ${browserErrorText(error)}`))
  streamingPage.on('response', recordPreviewResponse)
  streamingPage.on('requestfailed', recordPreviewFailure)
  await assertIsolation(await streamingPage.goto(`${siteOrigin}/start/latest/docs/framework/react/examples/start-streaming-data-from-server-functions?panel=playground`,
    { waitUntil: 'domcontentloaded', timeout: 120000 }), streamingPage)
  await streamingPage.locator('[data-native-preview-ready="true"]').waitFor({ timeout: 180000 })
  if (process.env.LOCAL_NATIVE_CAPTURE) await streamingPage.screenshot({ path: process.env.LOCAL_NATIVE_CAPTURE, fullPage: true })
  const streamingFrame = streamingPage.frames().find(item => item.url() === `${previewOrigin}/`)
  if (!streamingFrame) throw Error('Streaming preview frame did not open')
  await streamingFrame.waitForLoadState('networkidle', { timeout: 45000 })
  phase = 'streaming hydration'
  await waitForPinnedStartClient(streamingFrame)
  for (const [index, button] of [
    'Get 10 random numbers (ReadableStream)',
    'Get 10 random numbers (Async Generator Function)',
  ].entries()) {
    phase = `streaming button ${index + 1}`
    const observation = { button, rows: [] }
    if (streamingNetwork) {
      observation.beforeClick = await diagnosticWithin(() => streamingFrame.evaluate(buttonText => {
        const button = [...document.querySelectorAll('button')].find(element => element.textContent?.trim() === buttonText)
        return { readyState: document.readyState, text: button?.textContent,
          bindingKeys: Object.keys(button ?? {}).filter(key => key.startsWith('__react')),
          routerDevtoolsVisible: document.body?.innerText?.includes('TanStack Router'),
          resourceCount: performance.getEntriesByType('resource').length }
      }, button))
      streamingObservations.push(observation)
    }
    await streamingFrame.getByRole('button', { name: button }).click()
    const output = streamingFrame.locator('#streamed-results pre').nth(index)
    const started = Date.now()
    let first = ''
    for (let attempt = 0; attempt < 150; attempt++) {
      first = await output.textContent() ?? ''
      if (streamingNetwork && observation.rows.at(-1)?.characters !== first.length)
        observation.rows.push(streamedNumberObservation(first, Date.now() - started))
      if (first.includes('Number #1:')) break
      await page.waitForTimeout(100)
    }
    if (!first.includes('Number #1:')) throw Error(`${button} did not deliver a chunk; page errors: ${errors.join('; ')}`)
    if (Date.now() - started > 3000) throw Error(`${button} first chunk arrived too late`)
    if ((await output.textContent()).includes('Number #10:')) throw Error(`${button} buffered the full stream`)
    let complete = ''
    for (let attempt = 0; attempt < 100; attempt++) {
      complete = await output.textContent() ?? ''
      if (streamingNetwork && observation.rows.at(-1)?.characters !== complete.length)
        observation.rows.push(streamedNumberObservation(complete, Date.now() - started))
      if (complete.includes('Number #10:')) break
      await page.waitForTimeout(100)
    }
    if (!complete.includes('Number #10:')) throw Error(`${button} did not finish streaming`)
  }
  console.log(`${browserName}: Both Start streaming buttons delivered early chunks`)
  await streamingPage.close()
  assertNoUnexpectedErrors()
  }
  if (streamingNetwork) console.log('NATIVE_SITE_STREAM_OBSERVATION ' + JSON.stringify({
    browser: browserName, buttons: streamingObservations, network: streamingNetwork.snapshot(),
  }))
} catch (error) {
  const frames=page.frames().filter(frame=>frame.url().startsWith(previewOrigin+'/'))
  const report={browser:browserName,phase,error:String(error),errors,failedPreviewResponses,failedPreviewRequests,documentTraces,previewRequests:previewRequests.slice(-40),interactionTrace,
    frames:await Promise.all(frames.map(async frame=>({url:frame.url(),detached:frame.isDetached(),state:await diagnosticWithin(()=>frame.evaluate(()=>({readyState:document.readyState,text:document.body?.innerText?.slice(0,2000),bindingKeys:Object.keys(document.querySelector('button')??{}).filter(key=>key.startsWith('__react')),resources:performance.getEntriesByType('resource').slice(-12).map(entry=>({name:entry.name,duration:entry.duration}))})))})))}
  if (streamingPage) {
    report.streamingObservations = streamingObservations
    if (streamingNetwork) report.streamingNetwork = streamingNetwork.snapshot()
    report.streamingWorkbench = await diagnosticWithin(() => streamingPage.locator('[data-native-preview-ready]').innerText({ timeout: 1000 }))
    report.streamingFrames = await Promise.all(streamingPage.frames().filter(frame => frame.url().startsWith(previewOrigin + '/')).map(async frame => ({
      url: frame.url(), detached: frame.isDetached(),
      state: await diagnosticWithin(() => frame.evaluate(() => ({
        readyState: document.readyState,
        text: document.body?.innerText?.slice(0, 4000),
        bindingKeys: Object.keys(document.querySelector('button') ?? {}).filter(key => key.startsWith('__react')),
        resources: performance.getEntriesByType('resource').slice(-12).map(entry => ({ name: entry.name, duration: entry.duration })),
      }))),
    })))
  }
  if(process.env.LOCAL_NATIVE_TRACE_INTERACTION==='1'){
    const frame=frames.find(frame=>frame.url()===previewOrigin+'/')
    report.secondClickDiagnostic=await diagnosticWithin(async()=>{
      await frame.getByRole('button',{name:'Add 1 to 0?'}).click({timeout:1000})
      await frame.getByRole('button',{name:'Add 1 to 1?'}).waitFor({timeout:3000})
      return {text:await frame.locator('body').innerText({timeout:1000})}
    })
  }
  console.error(JSON.stringify(report,null,2))
  if(process.env.LOCAL_NATIVE_FAILURE_REPORT)await writeFile(process.env.LOCAL_NATIVE_FAILURE_REPORT,JSON.stringify(report,null,2)+'\n',{flag:'wx'})
  if(process.env.LOCAL_NATIVE_FAILURE_CAPTURE)await page.screenshot({path:process.env.LOCAL_NATIVE_FAILURE_CAPTURE,fullPage:true}).catch(()=>{})
  throw error
} finally {
  streamingNetwork?.stop()
  await browser.close()
}
