import {test, expect} from '@playwright/test'

for (const ubsan of [false, true]) test(`metered interpreter runs Webpack WASM and survives limits (${ubsan ? 'UBSan' : 'release'})`, async ({page}, testInfo) => {
  await page.goto('/wasm-interpreter-probe/LICENSE')
  const report = await page.evaluate(ubsan => new Promise<{passed: number; failed: number; results: unknown[]}>((resolve, reject) => {
    const worker = new Worker('/fixtures/wasm-interpreter/browser.worker.mjs', {type: 'module'})
    const progress: unknown[] = []
    const timer = setTimeout(() => {
      worker.terminate(); reject(Error('Interpreter deadline exceeded after ' + JSON.stringify(progress)))
    }, 45000)
    const finish = () => { clearTimeout(timer); worker.terminate() }
    worker.onmessage = ({data}) => {
      if (data.type === 'progress') progress.push(data.row)
      if (data.type === 'complete') { finish(); resolve(data.report) }
      if (data.type === 'error') { finish(); reject(Error(data.error)) }
    }
    worker.onerror = event => { finish(); reject(Error(event.message)) }
    worker.postMessage({run: true, ubsan})
  }), ubsan)
  await testInfo.attach('interpreter-results', {body: JSON.stringify(report, null, 2), contentType: 'application/json'})
  expect(report.results).toHaveLength(34)
  expect(report.failed, JSON.stringify(report.results.filter((row: any) => !row.passed))).toBe(0)
  expect(report.passed).toBe(34)
  expect(await page.evaluate(() => 6 * 7)).toBe(42)
})
