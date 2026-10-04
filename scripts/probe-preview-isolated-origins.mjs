import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, firefox, webkit } from '@playwright/test'

const sdk = process.env.NATIVE_SDK_BUNDLE_DIR
const previewPort = Number(process.env.NATIVE_PREVIEW_PORT ?? 45233)
if (!sdk || !Number.isSafeInteger(previewPort) || previewPort < 1 || previewPort > 65535)
  throw Error('Set NATIVE_SDK_BUNDLE_DIR and a valid NATIVE_PREVIEW_PORT')
const host = createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  if (process.env.PROBE_PARENT_COEP !== 'none')
    response.setHeader('Cross-Origin-Embedder-Policy', process.env.PROBE_PARENT_COEP ?? 'require-corp')
  if (request.url === '/sdk/index.js') {
    response.setHeader('Content-Type', 'text/javascript')
    response.end(await readFile(join(sdk, 'index.js')))
    return
  }
  response.setHeader('Content-Type', 'text/html')
  response.end('<!doctype html><div id="first"></div><div id="second"></div>')
})
await new Promise(resolve => host.listen(0, '127.0.0.1', resolve))
const hostOrigin = `http://127.0.0.1:${host.address().port}`
try {
  for (const browserType of [chromium, firefox, webkit]) {
    const browser = await browserType.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.goto(hostOrigin)
      const result = await page.evaluate(async previewPort => {
        const { URLPreview } = await import('/sdk/index.js')
        const previews = []
        for (const [container, name] of [['first', 'a656a14ca1a2410faa0dde7a117fd8a9'], ['second', 'b656a14ca1a2410faa0dde7a117fd8a9']]) {
          const preview = await URLPreview.mount(document.getElementById(container), {
            origin: `http://${name}.localhost:${previewPort}`,
            server: { async fetch() {
              return new Response(`<html><head></head><body>${name} workspace <button style="position:absolute;left:10px;top:30px" onclick="this.textContent='clicked'">click me</button></body></html>`,
                { headers: { 'Content-Type': 'text/html' } })
            } },
          })
          previews.push(preview)
        }
        window.__isolatedPreviews = previews
        return Promise.all(previews.map(preview => preview.inspect()))
      }, previewPort)
      if (!result[0].text.includes('a656a14ca1a2410faa0dde7a117fd8a9 workspace') || !result[1].text.includes('b656a14ca1a2410faa0dde7a117fd8a9 workspace'))
        throw Error(`${browserType.name()} did not keep two preview origins separate: ${JSON.stringify(result)}`)
      const frame = page.locator('#first iframe[title="Workspace preview"]')
      const box = await frame.boundingBox()
      if (!box) throw Error(`${browserType.name()} did not show the first preview iframe`)
      await page.mouse.click(box.x + 35, box.y + 45)
      const afterClick = await page.evaluate(() => window.__isolatedPreviews[0].inspect())
      if (!afterClick.controls.some(control => control.text === 'clicked')) {
        try {
          await page.frameLocator('#first iframe[title="Workspace preview"]')
            .getByRole('button', {name:'click me'}).click({timeout:2000})
        } catch (error) {
          if (browserType.name() === 'firefox') console.log(`firefox frame locator click: ${String(error).split('\n')[0]}`)
        }
        const locatorClick = await page.evaluate(() => window.__isolatedPreviews[0].inspect())
        if (locatorClick.controls.some(control => control.text === 'clicked')) {
          console.log(`${browserType.name()} isolated preview accepted frame locator click but not pointer click`)
          continue
        }
        const programmatic = await page.evaluate(async () => {
          await window.__isolatedPreviews[0].click('button')
          return window.__isolatedPreviews[0].inspect()
        })
        if (!programmatic.controls.some(control => control.text === 'clicked'))
          throw Error(`${browserType.name()} did not respond to either click in the isolated preview: ${JSON.stringify(programmatic)}`)
        console.log(`${browserType.name()} isolated preview accepted inspector click but not pointer click`)
      } else console.log(`${browserType.name()} kept two simultaneous preview origins separate and pointer click worked`)
    } finally {
      await browser.close()
    }
  }
} finally {
  await new Promise((resolve, reject) => host.close(error => error ? reject(error) : resolve()))
}
