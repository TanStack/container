import { chromium, firefox, webkit } from '@playwright/test'

const browserName = process.env.NATIVE_TEST_BROWSER ?? 'chromium'
const browserType = { chromium, firefox, webkit }[browserName]
if (!browserType) throw Error(`Unsupported browser: ${browserName}`)
const siteOrigin = process.env.NATIVE_SITE_ORIGIN ?? 'http://127.0.0.1:4198'
const previewOrigin = process.env.NATIVE_PREVIEW_ORIGIN ?? 'http://127.0.0.1:4199'
const previewHostSuffix = process.env.NATIVE_PREVIEW_HOST_SUFFIX
const renderTimeoutMs = Number(process.env.NATIVE_PREVIEW_RENDER_TIMEOUT_MS ?? 30000)
const previewBase = new URL(previewOrigin)
const isPreviewURL = value => {
  let url
  try { url = new URL(value) } catch { return false }
  return previewHostSuffix
    ? url.protocol === previewBase.protocol && url.port === previewBase.port && url.hostname.endsWith(previewHostSuffix)
    : url.origin === previewOrigin
}
const browser = await browserType.launch({ headless: true })
const context = await browser.newContext()
const failures = []
const previewRequests = []
const pendingRequests = new Set()
const previewDocuments = []
const frameEvents = []
const pages = []
const previewOrigins = []
try {
  for (const [name, path] of [
    ['counter', 'start-counter'],
    ['streaming', 'start-streaming-data-from-server-functions'],
  ]) {
    const page = await context.newPage()
    pages.push(page)
    await page.addInitScript(() => {
      window.__nativeIframeLoads = []
      document.addEventListener('load', event => {
        if (event.target instanceof HTMLIFrameElement)
          window.__nativeIframeLoads.push({title:event.target.title,src:event.target.src,time:performance.now()})
      }, true)
    })
    page.on('pageerror', error => failures.push(`${name}: ${error}`))
    page.on('requestfailed', request => {
      pendingRequests.delete(request)
      if (isPreviewURL(request.url())) failures.push(`${name}: request ${request.url()} ${JSON.stringify(request.failure())}`)
    })
    page.on('request', request => {
      if (isPreviewURL(request.url())) {
        pendingRequests.add(request)
        previewRequests.push(`${name}: ${request.method()} ${request.url()}`)
        if (request.isNavigationRequest()) previewDocuments.push(`${name}: started ${request.url()}`)
      }
    })
    page.on('requestfinished', request => {
      pendingRequests.delete(request)
      if (isPreviewURL(request.url()) && request.isNavigationRequest())
        previewDocuments.push(`${name}: finished ${request.url()}`)
    })
    page.on('framenavigated', frame => {
      if (isPreviewURL(frame.url())) previewDocuments.push(`${name}: committed ${frame.url()}`)
    })
    page.on('frameattached', frame => frameEvents.push(`${name}: attached ${frame.url()}`))
    page.on('framedetached', frame => frameEvents.push(`${name}: detached ${frame.url()}`))
    page.on('response', response => {
      if (isPreviewURL(response.url()) && response.status() >= 400)
        failures.push(`${name}: HTTP ${response.status()} ${response.url()}`)
    })
    await page.goto(`${siteOrigin}/start/latest/docs/framework/react/examples/${path}?panel=playground`,
      { waitUntil: 'domcontentloaded', timeout: 120000 })
    try {
      await page.locator('[data-native-preview-ready="true"]').waitFor({ timeout: 180000 })
    } catch (error) {
      const status = await page.locator('[data-native-preview-ready] [role="status"]').allTextContents()
      const body = (await page.locator('body').innerText()).slice(-1500)
      throw Error(`${name} did not become ready: ${error}; status=${JSON.stringify(status)}; body=${body}; failures=${failures.join('; ')}`)
    }
    const frameElement = page.locator('iframe[title="Workspace preview"]')
    const frameURL = await frameElement.getAttribute('src')
    if (!frameURL || !isPreviewURL(frameURL))
      throw Error(`${name} preview iframe has an invalid source: ${frameURL}`)
    previewOrigins.push(new URL(frameURL).origin)
    try {
      await page.frameLocator('iframe[title="Workspace preview"]')
        .getByRole('button', { name: name === 'counter' ? 'Add 1 to 0?' : 'Get 10 random numbers (ReadableStream)' })
        .waitFor({ timeout: renderTimeoutMs })
    } catch (error) {
      if (browserName === 'firefox') await page.screenshot({ path: '/private/tmp/firefox-native-dynamic-preview.png', fullPage: false })
      const frameStates = await Promise.all(page.frames().map(async frame => {
        try {
          return { url: frame.url(), body: (await frame.locator('body').innerText({ timeout: 1000 })).slice(0, 500) }
        } catch (cause) { return { url: frame.url(), error: String(cause) } }
      }))
      const iframeLoads = await page.evaluate(() => window.__nativeIframeLoads)
      throw Error(`${name} preview did not render: ${error}; frames=${JSON.stringify(frameStates)}; iframeLoads=${JSON.stringify(iframeLoads)}; documents=${JSON.stringify(previewDocuments)}; frameEvents=${JSON.stringify(frameEvents)}; pending=${JSON.stringify([...pendingRequests].map(request => request.url()).slice(-30))}; requests=${JSON.stringify(previewRequests.slice(-20))}; failures=${failures.join('; ')}`)
    }
    console.log(`${browserName} ${name} is ready in the same browser context`)
  }
  if (previewHostSuffix && new Set(previewOrigins).size !== previewOrigins.length)
    throw Error(`Workspaces reused a preview origin: ${previewOrigins.join(', ')}`)
  const firstFrame = pages[0].frameLocator('iframe[title="Workspace preview"]')
  await firstFrame.getByRole('button', { name: 'Add 1 to 0?' }).click()
  await firstFrame.getByRole('button', { name: 'Add 1 to 1?' }).waitFor({ timeout: 30000 })
  if (failures.length) throw Error(`Preview failures: ${failures.join('; ')}`)
} finally {
  await context.close()
  await browser.close()
}
