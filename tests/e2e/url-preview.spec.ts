import { test, expect } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/sandbox.html')
  await page.waitForFunction(() => Boolean(window.sandboxLab))
})

test('URL preview hydrates real Start, navigates, reloads, and calls server functions', async ({
  page,
}) => {
  test.setTimeout(180000)
  page.on('pageerror', (error) => console.log('Preview error:', error.message))
  page.on('console', (message) => {
    if (message.type() === 'error')
      console.log('Browser error:', message.text())
  })
  await page.evaluate(async () => {
    const { Workspace, URLPreview, buildStartFixtureInBrowser } =
      window.sandboxLab
    const build = await buildStartFixtureInBrowser(() => {})
    const workspace = new Workspace({ files: build.artifacts })
    const server = await workspace.serveCode(build.code, { timeoutMs: 10000 })
    const assets = Object.fromEntries(
      Object.entries(build.artifacts)
        .filter(([path]) => path.startsWith('/app/dist/client/'))
        .map(([path, bytes]) => [path.slice('/app/dist/client'.length), bytes]),
    )
    const preview = await URLPreview.mount(
      document.querySelector('#preview')!,
      { origin: 'http://127.0.0.1:4174', server, assets },
    )
    Object.assign(window, { livePreview: preview, liveWorkspace: workspace })
  })
  const preview = page.frameLocator('#preview iframe')
  await preview.locator('#start-count').click()
  await expect(preview.locator('#start-count')).toHaveText('Count: 1')
  await preview.locator('#server-call').click()
  await expect(preview.locator('#server-reply')).toContainText('POST')
  await expect(preview.locator('#server-reply')).toContainText('_serverFn')
  const reply = JSON.parse(
    (await preview.locator('#server-reply').textContent())!,
  )
  expect(reply).toMatchObject({
    origin: 'http://127.0.0.1:4174',
    fetchSite: 'same-origin',
    clonedOrigin: 'http://127.0.0.1:4174',
  })
  await preview.locator('#about-link').click()
  await expect(preview.locator('#about-title')).toHaveText('Second route')
  const frame = page
    .frames()
    .find((frame) => frame.url() === 'http://127.0.0.1:4174/about')!
  expect(frame).toBeTruthy()
  await frame.evaluate(() => history.back())
  await expect(preview.locator('#start-count')).toBeVisible()
  await frame.evaluate(() => history.forward())
  await expect(preview.locator('#about-title')).toBeVisible()
  await frame.evaluate(() => location.reload())
  await expect(preview.locator('#about-title')).toBeVisible()
  await preview.locator('#home-link').click()
  await expect(preview.locator('#start-count')).toHaveText('Count: 0')
  const evidence = await page.evaluate(async () => {
    const live = (window as any).livePreview
    return {
      diagnostics: live.diagnostics,
      requests: live.requests,
      state: await live.inspect(),
    }
  })
  expect(evidence.diagnostics).toEqual([])
  expect(
    evidence.requests.some(
      (request: any) =>
        request.pathname.startsWith('/assets/') && request.status === 200,
    ),
  ).toBe(true)
  expect(
    evidence.requests.some(
      (request: any) => request.method === 'POST' && request.status === 200,
    ),
  ).toBe(true)
  expect(evidence.state.url).toBe('http://127.0.0.1:4174/')
  const denied = await page.evaluate(async () => {
    const response = await (window as any).livePreview.server.fetch(
      new Request('http://127.0.0.1:4174/_serverFn/unknown', {
        method: 'POST',
      }),
    )
    return { status: response.status, text: await response.text() }
  })
  expect(denied).toEqual({ status: 403, text: 'Forbidden' })
  await page.screenshot({
    path: `reports/start-url-${test.info().project.name}.png`,
    fullPage: true,
  })
})

test('URL preview origins stay separate and reject reuse and ownerless requests', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { Workspace, URLPreview } = window.sandboxLab
    const workspaces = [new Workspace(), new Workspace()]
    const previews = []
    for (const [index, workspace] of workspaces.entries()) {
      const server = await workspace.serveCode(
        `export default () => new Response('<!doctype html><html><head><title>Workspace ${index}</title></head><body>Workspace ${index}</body></html>', {headers:{'Content-Type':'text/html'}})`,
      )
      previews.push(
        await URLPreview.mount(document.querySelector('#preview')!, {
          origin: `http://127.0.0.1:${4174 + index}`,
          server,
        }),
      )
    }
    const states = await Promise.all(
      previews.map((preview) => preview.inspect()),
    )
    let duplicate = ''
    try {
      await URLPreview.mount(document.body, {
        origin: previews[0].origin,
        server: previews[1].server,
      })
    } catch (error) {
      duplicate = String(error)
    }
    let sameOrigin = ''
    try {
      await URLPreview.mount(document.body, {
        origin: location.origin,
        server: previews[1].server,
      })
    } catch (error) {
      sameOrigin = String(error)
    }
    Object.assign(window, { previews, workspaces })
    return { states, duplicate, sameOrigin }
  })
  expect(result.states.map((state) => state.text)).toEqual([
    'Workspace 0',
    'Workspace 1',
  ])
  expect(result.duplicate).toContain('already leased')
  expect(result.sameOrigin).toContain('separate')
  const frames = page
    .frames()
    .filter((frame) => /^http:\/\/127\.0\.0\.1:417[45]\/$/.test(frame.url()))
  await frames[0].evaluate(() => localStorage.setItem('probe', 'only-first'))
  expect(
    await frames[1].evaluate(() => localStorage.getItem('probe')),
  ).toBeNull()
  expect(
    await frames[0].evaluate(() => {
      try {
        return parent.document.title
      } catch {
        return 'denied'
      }
    }),
  ).toBe('denied')
  const orphan = await page.context().newPage()
  await page.evaluate(() => (window as any).previews[0].close())
  await page.evaluate(() => {
    const frame = document.createElement('iframe')
    frame.id = 'orphan-preview'
    frame.src = 'http://127.0.0.1:4174/orphan'
    document.body.append(frame)
  })
  await expect(
    page.frameLocator('#orphan-preview').locator('body'),
  ).toContainText('exactly one workspace owner')
  const response = await orphan.goto('http://127.0.0.1:4174/orphan')
  expect(response?.status()).toBe(503)
  // WebKit partitions third-party service workers from a new top-level tab.
  expect(await orphan.textContent('body')).toMatch(
    /exactly one workspace owner|No browser workspace attached/,
  )
  await orphan.close()
})

test('URL preview fails closed with ambiguous owners and recovers after removal', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const { Workspace, URLPreview } = window.sandboxLab
    const workspace = new Workspace()
    const server = await workspace.serveCode(
      `export default () => new Response('<html><head></head><body>One owner</body></html>', {headers:{'Content-Type':'text/html'}})`,
    )
    const preview = await URLPreview.mount(
      document.querySelector('#preview')!,
      { origin: 'http://127.0.0.1:4174', server },
    )
    Object.assign(window, { preview, workspace })
    const duplicate = document.createElement('iframe')
    duplicate.id = 'duplicate-bridge'
    duplicate.src = 'http://127.0.0.1:4174/__sandbox/bridge.html'
    await new Promise((resolve) => {
      duplicate.onload = resolve
      document.body.append(duplicate)
    })
  })
  const frame = page
    .frames()
    .find((frame) => frame.url() === 'http://127.0.0.1:4174/')!
  expect(await frame.evaluate(async () => (await fetch('/probe')).status)).toBe(
    503,
  )
  await page.evaluate(() =>
    document.querySelector('#duplicate-bridge')!.remove(),
  )
  await expect
    .poll(() => frame.evaluate(async () => (await fetch('/probe')).status))
    .toBe(200)
})

test('URL preview reconnects after the service worker is stopped', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'Worker-stop control is only available through Chromium CDP',
  )
  await page.evaluate(async () => {
    const { Workspace, URLPreview } = window.sandboxLab
    const workspace = new Workspace()
    const server = await workspace.serveCode(
      `export default () => new Response('<html><head></head><body>Still in browser</body></html>', {headers:{'Content-Type':'text/html'}})`,
    )
    const preview = await URLPreview.mount(
      document.querySelector('#preview')!,
      { origin: 'http://127.0.0.1:4174', server },
    )
    Object.assign(window, { preview, workspace })
  })
  const session = await page.context().newCDPSession(page)
  await session.send('ServiceWorker.enable')
  await session.send('ServiceWorker.stopAllWorkers')
  const frame = page
    .frames()
    .find((frame) => frame.url() === 'http://127.0.0.1:4174/')!
  const result = await frame.evaluate(async () => {
    const response = await fetch('/after-restart')
    return { status: response.status, text: await response.text() }
  })
  expect(result.status).toBe(200)
  expect(result.text).toContain('Still in browser')
  await session.detach()
})
