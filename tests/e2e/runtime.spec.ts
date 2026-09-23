import { expect, test } from '@playwright/test'

test('original runtime preserves shared stat and lstat file types',async({page})=>{
  await page.goto('/')
  await expect(page.locator('#status')).toHaveText('Ready',{timeout:20000})
  await page.locator('#source').fill(`import fs from 'node:fs';import fsp from 'node:fs/promises';
    export default {async fetch(){
      await fsp.writeFile('/stats/file','abc');
      const values=await Promise.all([fsp.stat('/stats/file'),fsp.lstat('/stats/file'),fsp.stat('/stats'),fsp.stat('/')]);
      return Response.json(values.map(s=>[s.isFile(),s.isDirectory(),s.isSymbolicLink(),s instanceof fs.Stats]));
    }}`)
  await page.locator('#compile').click()
  await expect(page.locator('#status')).toHaveText('Ready')
  await page.locator('#request').click()
  await expect(page.locator('#response')).toHaveText('[[true,false,false,true],[true,false,false,true],[false,true,false,true],[false,true,false,true]]')
})

test('compiles a virtual project and executes its request handler', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#status')).toHaveText('Ready', { timeout: 20_000 })
  await page.locator('#request').click()

  await expect(page.locator('#response')).toContainText('Hello, web-container!')
  await expect(page.locator('#response')).toContainText('runtime: browser-node')
  await expect(page.locator('#response')).toContainText('context: web-container')
  await expect(page.locator('#timing')).toContainText('200')
})

test('runs a Vite production build in the browser', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#status')).toHaveText('Ready', { timeout: 20_000 })

  await page.locator('#vite-smoke').click()
  await expect(page.locator('#status')).toHaveText('Vite ready', { timeout: 60_000 })
  await expect(page.locator('#response')).toContainText('/app/dist/main.js')
  await expect(page.locator('#response')).toContainText('answer')
  await expect(page.locator('#timing')).toContainText('browser Vite build')
})

test('builds and runs a real TanStack Start app in the browser', async ({ page }) => {
  test.setTimeout(180_000)
  const browserErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text())
  })
  page.on('pageerror', (error) => browserErrors.push(error.message))
  await page.goto('/')
  await expect(page.locator('#status')).toHaveText('Ready', { timeout: 20_000 })

  await page.locator('#load-start').click()
  await expect(page.locator('#status')).toHaveText('Start ready', { timeout: 120_000 })
  await expect(page.locator('#timing')).toContainText('packages')
  await expect(page.locator('#timing')).toContainText('outputs')
  await expect(page.locator('#timing')).toContainText('Vite')
  expect(browserErrors).toEqual([])
  await page.locator('#request').click()

  await expect(page.locator('#status')).toHaveText('Ready', { timeout: 20_000 })
  await expect(page.locator('#timing')).toContainText('200')
  const preview = page.frameLocator('#preview')
  await expect(preview.locator('h1')).toHaveText('Bare-bones Start')
  await expect(preview.locator('p').first()).toHaveText(
    'TanStack Start rendered inside the browser runtime.',
  )
  await expect(preview.locator('p').nth(1)).toHaveText('Request context: /')
  await expect.poll(async () => {
    const previewFrame = page.frames().find((frame) => frame !== page.mainFrame())
    return previewFrame?.title()
  }).toBe('TanStack Start browser runtime')
})

test('isolates AsyncLocalStorage through concurrent streamed requests', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#status')).toHaveText('Ready', { timeout: 20_000 })

  await page.locator('#source').fill(`
    import { AsyncLocalStorage } from 'node:async_hooks'
    const storage = new AsyncLocalStorage()
    const sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration))

    export default {
      fetch(request) {
        const id = new URL(request.url).pathname.slice(1)
        return storage.run(id, () => new Response(new ReadableStream({
          async pull(controller) {
            await sleep(id === 'first' ? 0 : 40)
            controller.enqueue(new TextEncoder().encode(storage.getStore()))
            controller.close()
          },
        })))
      }
    }
  `)
  await page.locator('#compile').click()
  await expect(page.locator('#status')).toHaveText('Ready')

  const result = await page.evaluate(async () => {
    const runtime = window.__webContainerSpike!.runtime
    const [first, second] = await Promise.all([
      runtime.fetch('https://runtime.local/first').then((response) => response.text()),
      runtime.fetch('https://runtime.local/second').then((response) => response.text()),
    ])
    return { first, second }
  })

  expect(result).toEqual({ first: 'first', second: 'second' })
})

test('hot-loads edited source without replacing the worker', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#status')).toHaveText('Ready', { timeout: 20_000 })

  const source = page.locator('#source')
  await source.fill(`export default {
    fetch() {
      return new Response('hot load reached')
    }
  }`)
  await page.locator('#compile').click()
  await expect(page.locator('#status')).toHaveText('Ready')
  await page.locator('#request').click()
  await expect(page.locator('#response')).toHaveText('hot load reached')
})

test('reports missing package imports at the compiler boundary', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#status')).toHaveText('Ready', { timeout: 20_000 })

  await page.locator('#source').fill("import React from 'react'; export default { fetch: () => new Response(React.version) }")
  await page.locator('#compile').click()

  await expect(page.locator('#status')).toHaveText('Compile failed')
  await expect(page.locator('#response')).toContainText("Package 'react' is not installed")
})
