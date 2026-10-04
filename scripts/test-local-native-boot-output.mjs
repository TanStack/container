import { chromium, firefox, webkit } from 'playwright'

const site = process.env.NATIVE_SITE_ORIGIN ?? 'http://127.0.0.1:4198'
const url = `${site}/start/latest/docs/framework/react/examples/start-counter?panel=playground`
const internalLabels = [
  'Mounting project',
  'Preparing dependency lockfile',
  'Native browser bindings ready',
  'Vite configuration loaded',
  'Starting Vite',
]

for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
  if (process.env.NATIVE_BROWSER && process.env.NATIVE_BROWSER !== name) continue
  const browser = await engine.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 })
    const overlay = page.locator('[data-native-boot-overlay]')
    await overlay.waitFor({ timeout: 30000 })
    const status = overlay.getByRole('status')
    await status.waitFor()
    const initialStatus = await status.textContent()
    await page.evaluate(() => {
      window.__nativeBootStatuses = []
      const capture = () => {
        const value = document.querySelector('[data-native-boot-overlay] [role="status"]')?.textContent
        if (value && window.__nativeBootStatuses.at(-1) !== value) window.__nativeBootStatuses.push(value)
      }
      capture()
      new MutationObserver(capture).observe(document.body, { childList: true, subtree: true, characterData: true })
    })
    await page.locator('[data-native-preview-ready="true"]').waitFor({ timeout: 180000 })
    const statuses = await page.evaluate(() => window.__nativeBootStatuses)
    if (statuses.some(value => /context|binding|runner|config|mounted|response|transform|module/i.test(value)))
      throw Error(`${name}: internal phase leaked into startup status: ${statuses.join(', ')}`)
    await page.getByRole('button', { name: 'Show terminal' }).click()
    await page.getByRole('button', { name: 'Process', exact: true }).click()
    const panel = page.getByRole('button', { name: 'Process', exact: true }).locator('..').locator('..')
    const viewport = panel.locator('.xterm-viewport').last()
    const height = await viewport.evaluate(element => element.scrollHeight)
    const screens = []
    for (let top = 0; top <= height; top += 24) {
      await viewport.evaluate((element, value) => { element.scrollTop = value }, top)
      await page.waitForTimeout(30)
      const text = await panel.locator('.xterm-rows').last().textContent() ?? ''
      if (screens.at(-1) !== text) screens.push(text)
    }
    const output = screens.join('\n[scroll]\n')
    if (internalLabels.some(label => output?.includes(label)))
      throw Error(`${name}: internal setup phases leaked into process output: ${output}`)
    if (!output?.trim()) throw Error(`${name}: process output was empty`)
    if (!output.includes('Local:')) throw Error(`${name}: process output lacked Vite's listening URL: ${output.slice(-2000)}`)
    if (output.includes('Failed to run dependency scan') || output.includes('error while updating dependencies'))
      throw Error(`${name}: Vite dependency optimization failed: ${output.slice(-2000)}`)
    if (process.env.NATIVE_DEBUG_OUTPUT === '1') console.log(output.slice(0, 12000))
    console.log(`${name}: status=${JSON.stringify(initialStatus)}, Vite listening URL visible in process output`)
    await page.close()
  } finally { await browser.close() }
}
