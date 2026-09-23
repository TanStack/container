import { test, expect } from '@playwright/test'

test('Vite measures module count versus expression depth and recovers after errors', async ({
  page,
  browserName,
}, info) => {
  await page.goto('/sandbox.html')
  const report = await page.evaluate(async () => {
    const engine = await window.sandboxLab.loadBrowserViteEngine()
    const results = []
    for (const shape of ['flat', 'deep-expression'])
      for (const count of [100, 500, 1000]) {
        const files: Record<string, string> = {}
        for (let i = 0; i < count; i++)
          files[`/app/src/m${i}.ts`] = `export const v=${i};`
        const variables = Array.from({ length: count }, (_, i) => 'v' + i)
        files['/app/src/main.ts'] =
          Array.from(
            { length: count },
            (_, i) => `import {v as v${i}} from './m${i}'`,
          ).join(';') +
          ';export const total=' +
          (shape === 'flat'
            ? '[' + variables.join(',') + '].reduce((a,b)=>a+b,0)'
            : variables.join('+'))
        const start = performance.now()
        try {
          const build = await engine.runBrowserViteSmokeBuild(files)
          const code = Object.entries(build.files).find(([name]) =>
            /\.(m?js)$/.test(name),
          )?.[1]
          if (!code)
            throw new Error(
              'No JavaScript output: ' + Object.keys(build.files).join(', '),
            )
          const w = new window.sandboxLab.Workspace({
            files: {
              '/built.mjs': code,
              '/test.mjs': `import {total} from './built.mjs';console.log(total)`,
            },
          })
          try {
            results.push({
              shape,
              modules: count,
              wallMs: performance.now() - start,
              buildMs: build.duration,
              outputBytes: Object.values(build.files).reduce(
                (sum, b) => sum + b.length,
                0,
              ),
              execution: await w.execute('/test.mjs'),
              error: '',
            })
          } finally {
            w.close()
          }
        } catch (error) {
          results.push({
            shape,
            modules: count,
            wallMs: performance.now() - start,
            error: String(error),
          })
        }
      }
    let failed = ''
    try {
      await engine.runBrowserViteSmokeBuild({
        '/app/src/main.ts': 'export const = broken',
      })
    } catch (e) {
      failed = String(e)
    }
    const recovered = await engine.runBrowserViteSmokeBuild({
      '/app/src/main.ts': 'export const recovered=42',
    })
    return {
      results,
      failed,
      recovered: Object.keys(recovered.files),
      memoryMeasurement:
        'Unavailable: no cross-browser browser-process memory API used',
    }
  })
  await info.attach('vite-scale.json', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  })
  for (const result of report.results) {
    if (result.error) {
      expect(browserName).toBe('webkit')
      expect(result.shape).toBe('deep-expression')
      expect(result.error).toContain('Maximum call stack size exceeded')
    } else {
      expect(result.execution!.exitCode, result.execution!.stderr).toBe(0)
      expect(Number(result.execution!.stdout)).toBe(
        (result.modules * (result.modules - 1)) / 2,
      )
    }
  }
  expect(report.failed).not.toBe('')
  expect(report.recovered.length).toBeGreaterThan(0)
})

test('HTTP transport exposes buffering, cancellation, and request head-of-line blocking', async ({
  page,
}, info) => {
  await page.goto('/sandbox.html')
  const report = await page.evaluate(async () => {
    const w = new window.sandboxLab.Workspace({
      files: {
        '/server.mjs': `
      export default {async fetch(request){
        const path=new URL(request.url).pathname;
        if(path==='/stream')return new Response(new ReadableStream({async start(c){c.enqueue(new TextEncoder().encode('first'));await new Promise(r=>setTimeout(r,100));console.log('stream-ended');c.enqueue(new TextEncoder().encode('last'));c.close()}}));
        if(path==='/slow')await new Promise(r=>setTimeout(r,100));
        return new Response(path);
      }}
    `,
      },
    })
    try {
      let streamEnded = false
      const server = await w.serve('/server.mjs', {
        onOutput: (_level, text) => {
          if (text.includes('stream-ended')) streamEnded = true
        },
      })
      const stream = await server.fetch('https://probe.invalid/stream')
      const buffering = streamEnded
      const body = await stream.text()
      const controller = new AbortController()
      controller.abort()
      let abortedRequest = 'fulfilled'
      try {
        await server.fetch(
          new Request('https://probe.invalid/fast', {
            signal: controller.signal,
          }),
        )
      } catch {
        abortedRequest = 'rejected'
      }
      const completion: string[] = []
      await Promise.all(
        ['/slow', '/fast'].map(async (path) => {
          await server.fetch('https://probe.invalid' + path)
          completion.push(path)
        }),
      )
      return {
        body,
        streamBufferedUntilEnd: buffering,
        preAbortedRequest: abortedRequest,
        completion,
        gaps: [
          'Streaming/backpressure',
          'Request AbortSignal propagation',
          'Concurrent request scheduling',
        ],
      }
    } finally {
      w.close()
    }
  })
  await info.attach('http-gaps.json', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  })
  expect(report.body).toBe('firstlast')
  // Pin observed gaps explicitly, not fake compatibility passes. Changing these
  // expectations requires implementing and verifying the corresponding contract.
  expect(report.streamBufferedUntilEnd).toBe(true)
  expect(report.preAbortedRequest).toBe('fulfilled')
  expect(report.completion).toEqual(['/slow', '/fast'])
})
