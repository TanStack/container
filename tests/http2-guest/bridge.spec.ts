import { test, expect } from '@playwright/test'
import { exchange, crossProcess } from '../../fixtures/guest-http2-bridge.mjs'

for (const guestWasm of [false, true]) for (const [name, source, expected] of [
  ['virtual socket exchange', exchange, JSON.stringify({ received: 2 * 1024 * 1024 + 19, status: '201', custom: '42' }) + '\n'],
  ['cross-process authority', crossProcess, 'child denied; parent session intact\n'],
]) test(`${guestWasm ? 'WASM bridge' : 'default engine'}: ${name}`, async ({ page }, info) => {
  await page.goto('/sandbox.html')
  const result = await page.evaluate(async ({ source, guestWasm }) => {
    const kernel = new window.sandboxLab.WorkerKernel({ '/main.mjs': source })
    try { return await kernel.runModule('/main.mjs', { guestWasm, maxBytes: 32 * 1024 * 1024, timeoutMs: 20000 }) }
    finally { kernel.close() }
  }, { source, guestWasm })
  await info.attach('http2-guest.json', { body: JSON.stringify(result), contentType: 'application/json' })
  expect(result.exitCode, result.stderr).toBe(0)
  expect(result.stdout).toBe(expected)
})

for (const guestWasm of [false, true]) for (const cancelled of [false, true]) test(`${guestWasm ? 'WASM bridge' : 'default engine'}: repeated ${cancelled ? 'cancellation' : 'exit'} releases HTTP/2 owners`, async ({ page }) => {
  await page.goto('/sandbox.html')
  const results = await page.evaluate(async ({ guestWasm, cancelled }) => {
    const source = `import net from 'node:net';import tls from 'node:tls';
      ${cancelled ? '' : 'tls.createSecureContext({});'}
      const call=globalThis.__webContainerHost.http2.call;
      const id=call('open',false);const stream=call('request',id);
      call('write',id,stream,Array(65536).fill(42),false);
      ${cancelled ? 'tls.createSecureContext({});' : ''}
      ${cancelled ? "net.createServer().listen(8498,()=>console.log('ready'));" : "console.log('done');"}`
    const kernel = new window.sandboxLab.WorkerKernel({ '/main.mjs': source })
    const results = []
    try {
      for (let i = 0; i < 6; i++) {
        if (!cancelled) { results.push(await kernel.runModule('/main.mjs', { guestWasm, maxBytes: 32 * 1024 * 1024 })); continue }
        const child = await kernel.spawn('node', ['/main.mjs'], { guestWasm, lifetime: 'session', maxBytes: 32 * 1024 * 1024 })
        try { const ready = await child.next(); await child.kill(); results.push({ ready, stopped: await child.wait() }) }
        finally { await child.dispose() }
      }
      return results
    } finally { kernel.close() }
  }, { guestWasm, cancelled })
  expect(results).toHaveLength(6)
  for (const result of results) {
    if ('stopped' in result) { expect(result.ready?.type).toBe('stdout'); expect(result.stopped.signal).toBe('SIGTERM') }
    else { expect(result.exitCode, result.stderr).toBe(0); expect(result.stdout).toBe('done\n') }
  }
})
