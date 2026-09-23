import { test, expect } from '@playwright/test'
const owned = process.env.HTTP2_OWNED === '1'

for (const fragment of [1, 13, 16384]) test(`HTTP/2 multiplexing, flow control and reset with ${fragment}-byte fragments`, async ({ page }) => {
  await page.goto('/sandbox.html')
  const result = await page.evaluate(async ({ fragment, owned }) => {
    const runtime = owned ? 'http2-runtime' : 'http2-probe'
    const modulePath = `/${runtime}/http2.mjs`, workflowPath = owned ? '/fixtures/http2-owned-workflow.mjs' : '/fixtures/http2-workflow.mjs'
    const { default: factory } = await import(/* @vite-ignore */ modulePath)
    const { http2Workflow } = await import(/* @vite-ignore */ workflowPath)
    const binary = new Uint8Array(await (await fetch(`/${runtime}/http2.wasm`)).arrayBuffer())
    return http2Workflow(factory, binary, fragment)
  }, { fragment, owned })
  expect(result.streams).toBe(3)
  expect(result.resetPeers).toBe(2)
})

test('HTTP/2 memory limits, invalid input and recovery', async ({ page }) => {
  await page.goto('/sandbox.html')
  const result = await page.evaluate(async owned => {
    const runtime = owned ? 'http2-runtime' : 'http2-probe'
    const modulePath = `/${runtime}/http2.mjs`, workflowPath = owned ? '/fixtures/http2-owned-workflow.mjs' : '/fixtures/http2-workflow.mjs'
    const { default: factory } = await import(/* @vite-ignore */ modulePath)
    const { http2Limits } = await import(/* @vite-ignore */ workflowPath)
    return http2Limits(factory, new Uint8Array(await (await fetch(`/${runtime}/http2.wasm`)).arrayBuffer()))
  }, owned)
  expect(result.failures).toBeGreaterThan(0)
  expect(result.successes).toBeGreaterThan(0)
  expect(result.recovered).toBe(true)
})

for (const fragment of [13, 16384]) test(`HTTP/2 streaming pauses and resumes with ${fragment}-byte fragments`, async ({ page }) => {
  await page.goto('/sandbox.html')
  const result = await page.evaluate(async ({ fragment, owned }) => {
    const runtime = owned ? 'http2-runtime' : 'http2-probe'
    const modulePath = `/${runtime}/http2.mjs`, workflowPath = owned ? '/fixtures/http2-owned-workflow.mjs' : '/fixtures/http2-workflow.mjs'
    const { default: factory } = await import(/* @vite-ignore */ modulePath)
    const { http2Streaming } = await import(/* @vite-ignore */ workflowPath)
    return http2Streaming(factory, new Uint8Array(await (await fetch(`/${runtime}/http2.wasm`)).arrayBuffer()), fragment)
  }, { fragment, owned })
  expect(result.bytesEachDirection).toBe(3 * 1024 * 1024 + 17)
  expect(result.requestPaused).toBe(65535)
  expect(result.responsePaused).toBe(65535)
  expect(Math.max(...result.peak)).toBeLessThan(1024 * 1024)
})
