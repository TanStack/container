import { chromium, firefox, webkit } from '@playwright/test'

const port = Number(process.env.NATIVE_PREVIEW_PORT ?? 45233)
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw Error('Invalid preview port')
for (const browserType of [chromium, firefox, webkit]) {
  const browser = await browserType.launch({ headless: true })
  try {
    const context = await browser.newContext()
    const origins = []
    for (const name of ['first', 'second']) {
      const page = await context.newPage()
      const origin = `http://${name}.localhost:${port}`
      await page.goto(origin + '/__sandbox/bridge.html')
      const result = await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.register('/__sandbox/sw.js', { scope: '/' })
        await navigator.serviceWorker.ready
        return {
          origin: location.origin,
          secureContext: isSecureContext,
          activeScope: registration.scope,
          controller: Boolean(navigator.serviceWorker.controller),
        }
      })
      origins.push(result)
    }
    console.log(JSON.stringify({ browser: browserType.name(), origins }))
    await context.close()
  } finally {
    await browser.close()
  }
}
