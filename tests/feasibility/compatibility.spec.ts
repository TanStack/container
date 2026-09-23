import { test, expect } from '@playwright/test'
import cases from '../../src/feasibility/cases.json' with { type: 'json' }

test('Node reference matrix reports matches and gaps separately', async ({
  page,
}, info) => {
  await page.goto('/sandbox.html')
  const report = await page.evaluate(() => window.sandboxLab.runCompatibility())
  await info.attach('compatibility.json', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  })
  expect(report.results).toHaveLength(cases.length * 2)
  // These are required regression gates, not expected-failure annotations.
  // The rest remain measured compatibility gaps in the report.
  const required = [
    'esm-live-bindings',
    'commonjs-static',
    'dynamic-import-literal',
    'package-exports-import',
    'package-exports-require',
    'package-json-require',
    'path-relative-parent',
    'path-resolve-absolute-reset',
    'path-trailing-slash',
    'fs-async-text',
    'fs-async-binary',
    'microtask-order',
    'process-env-argv',
    'als-bind',
  ]
  for (const result of report.results.filter((x) => required.includes(x.id)))
    expect(
      result.status,
      `${result.backend}/${result.id}: ${JSON.stringify(result.actual)}`,
    ).toBe('match')
  expect(report.crossOriginIsolated).toBe(false)
})

test('pinned upstream path subset preserves assertions and explicit skips', async ({
  page,
}, info) => {
  await page.goto('/sandbox.html')
  const report = await page.evaluate(async () => {
    const fixture = await (
      await fetch('/feasibility/path-upstream.json')
    ).json()
    const w = new window.sandboxLab.Workspace({ files: fixture.files })
    try {
      return {
        expected: fixture.expected,
        sources: fixture.sources,
        native: await w.execute('/main.cjs'),
        quickjs: await w.executeInVM('/main.cjs'),
      }
    } finally {
      w.close()
    }
  })
  await info.attach('upstream-path.json', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  })
  for (const run of [report.native, report.quickjs]) {
    expect(run.exitCode, run.stderr).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual(report.expected)
  }
  expect(report.expected.assertions).toBeGreaterThan(250)
  expect(report.expected.skipped.length).toBeGreaterThan(0)
})

test('phone synchronous I/O probe runs without shared memory', async ({
  page,
}, info) => {
  await page.goto('/sandbox.html')
  const result = await page.evaluate(() => window.sandboxLab.runSynchronousIO())
  await info.attach('phone-sync-io.json', {
    body: JSON.stringify(result),
    contentType: 'application/json',
  })
  expect(result.status).toBe('pass')
})

test('Asyncify synchronous filesystem uses live host authority without shared memory', async ({
  page,
}, info) => {
  await page.goto('/sandbox.html')
  const result = await page.evaluate(async () => {
    const w = new window.sandboxLab.Workspace({
      files: {
        '/value': 'before',
        '/main.mjs': `import {readFileSync,writeFileSync,statSync,readdirSync} from 'node:fs';
        console.log('ready');
        console.log(readFileSync('/value','utf8'));
        writeFileSync('/binary',new Uint8Array([0,128,255]));
        console.log(JSON.stringify(Array.from(readFileSync('/binary'))));
        console.log(statSync('/binary').size,statSync('/binary').isFile());
        console.log(readdirSync('/').includes('binary'));
        console.log(JSON.stringify({sab:typeof SharedArrayBuffer,fetch:typeof fetch,Worker:typeof Worker}));`,
        '/bench.mjs': `import {readFileSync} from 'node:fs'; for(let i=0;i<100;i++)readFileSync('/value','utf8'); console.log('100 reads')`,
      },
    })
    try {
      const options = { engine: 'asyncify' as const, timeoutMs: 10000 }
      const run = await w.executeInVM('/main.mjs', {
        ...options,
        onOutput: (_level, text) => {
          if (text === 'ready\n' || text === 'ready')
            void w.files.writeText('/value', 'host-updated')
        },
      })
      const bench = await w.executeInVM('/bench.mjs', options)
      return {
        run,
        bench,
        bytes: Array.from(await w.files.readFile('/binary')),
        sharedArrayBuffer: typeof SharedArrayBuffer,
        crossOriginIsolated,
      }
    } finally {
      w.close()
    }
  })
  await info.attach('asyncify.json', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  })
  expect(result.run.exitCode, result.run.stderr).toBe(0)
  expect(result.run.stdout).toContain('host-updated')
  expect(result.run.stdout).toContain('[0,128,255]')
  expect(result.run.stdout).toContain('3 true')
  expect(result.run.stdout).toContain('"fetch":"undefined"')
  expect(result.bytes).toEqual([0, 128, 255])
  expect(result.bench.exitCode, result.bench.stderr).toBe(0)
  expect(result.crossOriginIsolated).toBe(false)
})

test('Asyncify authority, interruption, suspension cancellation and async boundary', async ({
  page,
}, info) => {
  await page.goto('/sandbox.html')
  const result = await page.evaluate(async () => {
    const w = new window.sandboxLab.Workspace({
      files: {
        '/write.mjs': `import {writeFileSync} from 'node:fs';writeFileSync('/blocked','no')`,
        '/escape.mjs': `import {writeFileSync} from 'node:fs';writeFileSync('/../escape','no')`,
        '/loop.mjs': `import {readFileSync} from 'node:fs';readFileSync('/value','utf8');while(true){}`,
        '/cancel.mjs': `import {readFileSync} from 'node:fs';console.log('cancel');readFileSync('/value','utf8');while(true){}`,
        '/async.mjs': `await Promise.resolve(); console.log('not implemented')`,
        '/heap.mjs': `console.log('x'.repeat(4*1024*1024))`,
        '/value': '42',
      },
    })
    try {
      const options = { engine: 'asyncify' as const, timeoutMs: 500 }
      const readonly = await w.executeInVM('/write.mjs', {
        ...options,
        writable: false,
      })
      const escape = await w.executeInVM('/escape.mjs', options)
      const loop = await w.executeInVM('/loop.mjs', options)
      const heap = await w.executeInVM('/heap.mjs', {
        ...options,
        maxBytes: 1024 * 1024,
      })
      const async = await w.executeInVM('/async.mjs', options)
      const blocked = await w.files.exists('/blocked')
      const cancelled = await w.executeInVM('/cancel.mjs', {
        ...options,
        onOutput: () => w.close(),
      })
      return { readonly, escape, loop, heap, async, blocked, cancelled }
    } finally {
      w.close()
    }
  })
  await info.attach('asyncify-limits.json', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  })
  expect(result.readonly.stderr).toContain('read-only')
  expect(result.escape.stderr).toContain('escape')
  expect(result.loop.stderr).toMatch(/interrupted|timed out/)
  expect(result.heap.stderr).toMatch(/memory/i)
  expect(result.async.stderr).toContain('synchronous modules only')
  expect(result.blocked).toBe(false)
  expect(result.cancelled.stderr).toContain('Workspace closed')
})

test('repeated executions, output flood, and checkpoint reload recover', async ({
  page,
}, info) => {
  await page.goto('/sandbox.html')
  const result = await page.evaluate(async () => {
    const durations = []
    for (const backend of ['native', 'quickjs'] as const) {
      const w = new window.sandboxLab.Workspace({
        files: {
          '/value': '0',
          '/main.mjs': `import {readFile,writeFile} from 'node:fs/promises';const n=Number(await readFile('/value','utf8'))+1;await writeFile('/value',String(n));console.log(n)`,
          '/flood.mjs': `for(let i=0;i<100;i++) console.log('x'.repeat(16384)); await new Promise(()=>{})`,
        },
      })
      try {
        const execute = (entry: string) =>
          backend === 'native' ? w.execute(entry) : w.executeInVM(entry)
        for (let i = 1; i <= 12; i++) {
          const r = await execute('/main.mjs')
          if (r.exitCode || r.stdout !== i + '\n')
            throw new Error(JSON.stringify(r))
          durations.push({ backend, iteration: i, ms: r.duration })
        }
        const flood = await execute('/flood.mjs')
        if (!flood.stderr.includes('Output quota exceeded'))
          throw new Error('Output flood was not bounded: ' + flood.stderr)
        const recovered = await execute('/main.mjs')
        if (recovered.stdout !== '13\n')
          throw new Error('Workspace did not recover')
        await w.save('feasibility-' + backend)
      } finally {
        w.close()
      }
    }
    return durations
  })
  await page.reload()
  const restored = await page.evaluate(async () => {
    const values = []
    for (const backend of ['native', 'quickjs']) {
      const key = 'feasibility-' + backend
      const w = await window.sandboxLab.Workspace.open(key)
      try {
        values.push(await w.files.readText('/value'))
      } finally {
        w.close()
        await window.sandboxLab.checkpoint('delete', key)
      }
    }
    return values
  })
  await info.attach('repeated-execution.json', {
    body: JSON.stringify({ result, restored }, null, 2),
    contentType: 'application/json',
  })
  expect(restored).toEqual(['13', '13'])
})
