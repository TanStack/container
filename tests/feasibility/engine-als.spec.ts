import { test, expect } from '@playwright/test'
import cases from '../../src/feasibility/als-cases.json' with { type: 'json' }
import reference from '../../reports/engine-als.json' with { type: 'json' }

test('patched QuickJS native await matches Node ALS cases', async ({ page }, info) => {
  await page.goto('/sandbox.html')
  const report = await page.evaluate(() => window.sandboxLab.runEngineALS())
  await info.attach('engine-als-browser.json', { body: JSON.stringify(report), contentType: 'application/json' })
  expect(report.results).toHaveLength(cases.length)
  expect(report.crossOriginIsolated).toBe(false)
  for (const row of report.results) {
    expect(row.actual.exitCode, `${row.id}: ${row.actual.stderr}`).toBe(0)
    expect(row.actual.stdout.trim(), row.id).toBe(reference.results.find(x => x.id === row.id)!.expected)
  }
})

test('phone ALS action produces a downloadable report', async ({page},info) => {
  await page.setViewportSize({width:393,height:852})
  await page.goto('/sandbox.html')
  await page.getByRole('button',{name:'Test native QuickJS ALS'}).click()
  await expect(page.locator('#output')).toContainText(`${cases.length}/${cases.length} matched Node`,{timeout:120000})
  await expect(page.getByRole('link',{name:'Download ALS report'})).toBeVisible()
  await info.attach('phone-als.png',{body:await page.screenshot({fullPage:true}),contentType:'image/png'})
  const downloadEvent=page.waitForEvent('download')
  await page.getByRole('link',{name:'Download ALS report'}).click()
  const download=await downloadEvent
  expect(download.suggestedFilename()).toBe('sandbox-engine-als.json')
})

test('engine ALS survives host filesystem RPC, microtasks, and timers', async ({ page }) => {
  await page.goto('/sandbox.html')
  const result = await page.evaluate(async () => {
    const w = new window.sandboxLab.Workspace({ files: {
      '/value': 'ok',
      '/main.mjs': `import {AsyncLocalStorage} from 'node:async_hooks';
        import {readFile} from 'node:fs/promises';
        const s=new AsyncLocalStorage();
        const rows=await Promise.all(['a','b','c'].map(v=>s.run(v,async()=>{
          const value=await readFile('/value','utf8');
          const micro=await new Promise(resolve=>queueMicrotask(()=>resolve(s.getStore())));
          const timer=await new Promise(resolve=>setTimeout(()=>resolve(s.getStore()),5));
          return [v,value,micro,timer,s.getStore()];
        })));
        let canceled=true;const id=setTimeout(()=>{canceled=false},1);clearTimeout(id);
        await new Promise(resolve=>setTimeout(resolve,10));
        console.log(JSON.stringify({rows,canceled,outer:s.getStore()??null,
          hooks:[typeof __qjsGetAsyncContext,typeof __qjsSetAsyncContext,typeof __scheduleTimer],
          ambient:[typeof fetch,typeof document]}));`,
    } })
    try { return await w.executeInVM('/main.mjs', { engine: 'quickjs-als' }) }
    finally { w.close() }
  })
  expect(result.exitCode, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({
    rows: ['a','b','c'].map(v=>[v,'ok',v,v,v]), canceled:true, outer:null,
    hooks:['undefined','undefined','undefined'], ambient:['undefined','undefined'],
  })
})

test('engine ALS preserves limits and fresh runtime after interruption', async ({ page }) => {
  await page.goto('/sandbox.html')
  const rows = await page.evaluate(async () => {
    const w = new window.sandboxLab.Workspace({files:{
      '/loop.mjs': `import {AsyncLocalStorage} from 'node:async_hooks'; new AsyncLocalStorage().run(1,()=>{for(;;){}})`,
      '/heap.mjs': `import {AsyncLocalStorage} from 'node:async_hooks'; await new AsyncLocalStorage().run(1,async()=>{await 0; return new Uint8Array(2*1024*1024)})`,
      '/ok.mjs': `import {AsyncLocalStorage} from 'node:async_hooks'; console.log(await new AsyncLocalStorage().run(42,async()=>{await 0;return 42}))`,
    }})
    try {
      return [await w.executeInVM('/loop.mjs',{engine:'quickjs-als',timeoutMs:100}),
        await w.executeInVM('/heap.mjs',{engine:'quickjs-als',maxBytes:1024*1024}),
        await w.executeInVM('/ok.mjs',{engine:'quickjs-als'})]
    } finally {w.close()}
  })
  expect(rows[0].exitCode).toBe(1)
  expect(rows[0].stderr).toMatch(/interrupt|timed out/i)
  expect(rows[1].exitCode).toBe(1)
  expect(rows[1].stderr).toMatch(/memory/i)
  expect(rows[2].stdout.trim()).toBe('42')
  expect(rows[2].exitCode).toBe(0)
})
