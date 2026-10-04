import { chromium, firefox, webkit } from 'playwright'

const siteOrigin = process.env.NATIVE_SITE_ORIGIN ?? 'http://127.0.0.1:4198'
const previewOrigin = process.env.NATIVE_PREVIEW_ORIGIN ?? 'http://127.0.0.1:4199'
const url = `${siteOrigin}/start/latest/docs/framework/react/examples/start-streaming-data-from-server-functions?panel=playground`

for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
  if (process.env.NATIVE_BROWSER && process.env.NATIVE_BROWSER !== name) continue
  const browser = await engine.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const pageErrors = []
    const previewRequests = []
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('request', request => {
      if (request.url().startsWith(previewOrigin)) previewRequests.push(`request ${request.method()} ${request.url()}`)
    })
    page.on('response', response => {
      if (response.url().startsWith(previewOrigin)) previewRequests.push(`response ${response.status()} ${response.url()}`)
    })
    page.on('requestfailed', request => {
      if (request.url().startsWith(previewOrigin)) previewRequests.push(`failed ${request.failure()?.errorText} ${request.url()}`)
    })
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 })
    await page.locator('[data-native-preview-ready="true"]').waitFor({ timeout: 180000 })
    if (process.env.NATIVE_SKIP_TERMINAL !== '1') {
    await page.getByRole('button', { name: 'Show terminal' }).click()
    await page.getByRole('button', { name: 'Terminal', exact: true }).click()
    const terminal = page.getByRole('region', { name: 'Sandbox terminal' })
    const input = terminal.locator('textarea[aria-label="Sandbox terminal"]')
    await input.focus()
    await page.keyboard.type('pwd')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => {
      const text = document.querySelector('[data-native-terminal] .xterm-rows')?.textContent ?? ''
      return text.includes('/project') && text.trimEnd().endsWith('project $')
    }, undefined, { timeout: 30000 })
    await page.keyboard.type('node -e "console.log(6 * 7)"')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => {
      const text = document.querySelector('[data-native-terminal] .xterm-rows')?.textContent ?? ''
      return text.includes('42') && text.trimEnd().endsWith('project $')
    }, undefined, { timeout: 30000 })
    if (process.env.NATIVE_STREAMING_BUILD === '1') {
      await page.keyboard.type('node -e "console.log(require(\'./package.json\').scripts.build)"')
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => {
        const text = document.querySelector('[data-native-terminal] .xterm-rows')?.textContent ?? ''
        return text.includes('vite build') && text.trimEnd().endsWith('project $')
      }, undefined, { timeout: 30000 })
      console.log(`${name}: mounted build script: ${await terminal.locator('.xterm-rows').textContent()}`)
      await page.keyboard.type('pnpm run build')
      await page.keyboard.press('Enter')
      try {
        await page.waitForFunction(() => {
          const text = document.querySelector('[data-native-terminal] .xterm-rows')?.textContent ?? ''
          return text.includes('built in') && text.trimEnd().endsWith('project $')
        }, undefined, { timeout: 120000 })
      } catch (error) {
        throw Error(`${name}: streaming build output: ${await terminal.locator('.xterm-rows').textContent()}`, { cause: error })
      }
      const viewport = terminal.locator('.xterm-viewport')
      const height = await viewport.evaluate(element => element.scrollHeight)
      for (let offset = 0; offset <= height; offset += 24) {
        await viewport.evaluate((element, top) => { element.scrollTop = top }, offset)
        await page.waitForTimeout(30)
        const text = await terminal.locator('.xterm-rows').textContent() ?? ''
        if (text.includes('Exited with code')) throw Error(`${name}: declared build failed: ${text}`)
      }
      await viewport.evaluate((element, top) => { element.scrollTop = top }, height)
      await page.keyboard.type('pwd')
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => {
        const text = document.querySelector('[data-native-terminal] .xterm-rows')?.textContent ?? ''
        return text.includes('/project') && text.trimEnd().endsWith('project $')
      }, undefined, { timeout: 30000 })
    }
    }
    const frame = page.frames().find(item => item.url() === `${previewOrigin}/`)
    if (!frame) throw Error(`${name}: streaming preview frame missing`)
    await frame.waitForLoadState('load', { timeout: 30000 })
    await page.waitForTimeout(8000)
    await frame.getByRole('button', { name: 'Get 10 random numbers (ReadableStream)' }).click()
    const streamOutput = frame.locator('#streamed-results pre').first()
    try {
      await streamOutput.getByText(/Number #10:/).waitFor({ timeout: 30000 })
    } catch (error) {
      throw Error(`${name}: stream did not finish; output: ${await streamOutput.textContent()}; page errors: ${pageErrors.join('; ')}; requests: ${previewRequests.slice(-30).join(' | ')}`, { cause: error })
    }
    const sandboxErrors = pageErrors.filter(error => !error.includes('NavbarAuthControls'))
    if (sandboxErrors.length) throw Error(`${name}: page errors: ${sandboxErrors.join('; ')}`)
    if (pageErrors.length) console.log(`${name}: unrelated site auth hydration warning observed`)
    console.log(`${name}: streaming preview and terminal stayed usable together`)
  } finally {
    await browser.close()
  }
}
