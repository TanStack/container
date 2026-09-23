import { test, expect } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/sandbox.html')
  await page.waitForFunction(() => Boolean(window.sandboxLab))
})

test('QuickJS workspace executes an edit-test-file loop and persists binary data', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { Workspace } = window.sandboxLab
    const workspace = new Workspace({
      files: {
        '/math.ts': 'export const add = (a: number, b: number) => a - b',
        '/test.ts': `import {add} from './math'; if(add(2,3)!==5) throw new Error('expected 5'); console.log('test passed')`,
        '/main.ts': `
        import {writeFile,readFile,readdir,stat} from 'node:fs/promises';
        import process from 'node:process';
        await writeFile('/result.txt', 'hello 🦊');
        await writeFile('/binary.bin', new Uint8Array([0,128,255]));
        const [text, bytes, entries, info] = await Promise.all([readFile('/result.txt','utf8'), readFile('/binary.bin'), readdir('/'), stat('/binary.bin')]);
        console.log(JSON.stringify({text,bytes:Array.from(bytes),entries,file:info.isFile(),size:info.size,env:process.env.TEST,argv:process.argv,fetch:typeof fetch,document:typeof document,Worker:typeof Worker}));
      `,
      },
    })
    const failed = await workspace.executeInVM('/test.ts')
    await workspace.files.patch('/math.ts', 'a - b', 'a + b')
    const passed = await workspace.executeInVM('/test.ts')
    const executed = await workspace.executeInVM('/main.ts', {
      env: { TEST: 'scoped' },
      argv: ['test'],
    })
    await workspace.save('vm-workspace')
    workspace.close()
    const restored = await Workspace.open('vm-workspace')
    const bytes = Array.from(await restored.files.readFile('/binary.bin'))
    const text = await restored.files.readText('/result.txt')
    restored.close()
    return { failed, passed, executed, bytes, text }
  })
  expect(result.failed.exitCode).toBe(1)
  expect(result.failed.stderr).toContain('expected 5')
  expect(result.passed.exitCode, result.passed.stderr).toBe(0)
  expect(result.passed.stdout).toContain('test passed')
  expect(result.executed.exitCode, result.executed.stderr).toBe(0)
  const data = JSON.parse(result.executed.stdout)
  expect(data).toMatchObject({
    text: 'hello 🦊',
    bytes: [0, 128, 255],
    file: true,
    size: 3,
    env: 'scoped',
    argv: ['quickjs', '/main.ts', 'test'],
    fetch: 'undefined',
    document: 'undefined',
    Worker: 'undefined',
  })
  expect(result.bytes).toEqual([0, 128, 255])
  expect(result.text).toBe('hello 🦊')
})

test('QuickJS workspace enforces host file authority and isolates concurrent workspaces', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { Workspace } = window.sandboxLab
    const a = new Workspace({
      files: {
        '/write.ts': `import{writeFile}from'node:fs/promises';await writeFile('/value','first')`,
        '/escape.ts': `import{writeFile}from'node:fs/promises';await writeFile('/../escaped','no')`,
        '/missing.ts': `import{readFile}from'node:fs/promises';await readFile('/missing')`,
      },
    })
    const b = new Workspace({
      files: {
        '/write.ts': `import{writeFile}from'node:fs/promises';await writeFile('/value','second')`,
      },
    })
    const readonly = await a.executeInVM('/write.ts', { writable: false })
    const existsAfterReadonly = await a.files.exists('/value')
    const escape = await a.executeInVM('/escape.ts')
    const missing = await a.executeInVM('/missing.ts')
    const parallel = await Promise.all([
      a.executeInVM('/write.ts'),
      b.executeInVM('/write.ts'),
    ])
    const values = await Promise.all([
      a.files.readText('/value'),
      b.files.readText('/value'),
    ])
    a.close()
    b.close()
    return { readonly, existsAfterReadonly, escape, missing, parallel, values }
  })
  expect(result.readonly.stderr).toContain('read-only')
  expect(result.existsAfterReadonly).toBe(false)
  expect(result.escape.exitCode).toBe(1)
  expect(result.escape.stderr).toContain('escape')
  expect(result.missing.stderr).toContain('ENOENT')
  expect(result.parallel.map((result) => result.exitCode)).toEqual([0, 0])
  expect(result.values).toEqual(['first', 'second'])
})

test('QuickJS workspace bounds CPU, heap, unresolved awaits, and cancellation', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { Workspace } = window.sandboxLab
    const workspace = new Workspace({
      files: {
        '/loop.ts': 'while(true){}',
        '/heap.ts': `console.log('x'.repeat(4*1024*1024))`,
        '/pending.ts': 'await new Promise(()=>{})',
        '/async-loop.ts': `await Promise.resolve(); while(true){}`,
        '/cancel.ts': `console.log('running'); await new Promise(()=>{})`,
      },
    })
    const cpu = await workspace.executeInVM('/loop.ts', { timeoutMs: 50 })
    const heap = await workspace.executeInVM('/heap.ts', {
      maxBytes: 1024 * 1024,
    })
    const pending = await workspace.executeInVM('/pending.ts', {
      timeoutMs: 50,
    })
    const asyncCpu = await workspace.executeInVM('/async-loop.ts', {
      timeoutMs: 50,
    })
    const cancellation = await workspace.executeInVM('/cancel.ts', {
      onOutput: () => workspace.close(),
    })
    return { cpu, heap, pending, asyncCpu, cancellation }
  })
  for (const resultItem of Object.values(result))
    expect(resultItem.exitCode, resultItem.stderr).toBe(1)
  expect(result.cpu.stderr).toMatch(/interrupted|timed out/)
  expect(result.asyncCpu.stderr).toMatch(/interrupted|timed out/)
  expect(result.heap.stderr).toContain('out of memory')
  expect(result.pending.stderr).toContain('timed out')
  expect(result.cancellation.stderr).toContain('Workspace closed')
})
