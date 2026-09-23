import { test, expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { guestHTTP2Cases } from '../../fixtures/guest-http2-cases.mjs'

for (const guestWasm of [false, true]) for (const [name, source] of Object.entries(guestHTTP2Cases)) test(`${guestWasm ? 'WASM bridge' : 'default engine'}: ${name}`, async ({ page }, info) => {
  const node = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 15000, env: { ...process.env, FORCE_COLOR: '0' } })
  expect(node.status, node.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const result = await page.evaluate(async ({ source, guestWasm }) => {
    const kernel = new window.sandboxLab.WorkerKernel({ '/main.mjs': source })
    try { return await kernel.runModule('/main.mjs', { guestWasm, webAPIs: true, maxBytes: 32 * 1024 * 1024, timeoutMs: 15000 }) }
    finally { kernel.close() }
  }, { source, guestWasm })
  await info.attach('http2-api.json', { body: JSON.stringify({ node: node.stdout, result }), contentType: 'application/json' })
  expect(result.exitCode, result.stderr).toBe(0)
  expect(result.stdout).toBe(node.stdout)
})
