import { expect, test } from '@playwright/test'

test('agent tool loop fixes a test, runs a preview, and restores a checkpoint', async ({
  page,
}, testInfo) => {
  await page.goto('/sandbox.html')
  await page.locator('#run').click()
  await expect(page.locator('#output')).toContainText(
    'Checkpoint restored and test passed again',
    { timeout: 25_000 },
  )
  await expect(page.locator('#output')).toContainText('Expected failure before repair:')
  await expect(
    page.frameLocator('#preview iframe').locator('#result'),
  ).toHaveText('5')
  await page.screenshot({
    path: `reports/agent-workflow-${testInfo.project.name}.png`,
    fullPage: true,
  })
})

test('runs TypeScript and denies ambient network and storage', async ({
  page,
}) => {
  await page.goto('/sandbox.html')
  const requests: string[] = []
  const failures: string[] = []
  const responses: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('guest-exfil')) requests.push(request.url())
  })
  page.on('requestfailed', (request) => {
    if (request.url().includes('guest-exfil'))
      failures.push(request.failure()?.errorText ?? '')
  })
  page.on('response', (response) => {
    if (response.url().includes('guest-exfil'))
      responses.push(String(response.status()))
  })
  const result = await page.evaluate(async () => {
    const workspace = new window.sandboxLab.Workspace({
      files: {
        '/test.ts': `
        const result: Record<string, unknown> = { origin: self.origin, document: typeof document, sharedMemory: typeof SharedArrayBuffer };
        try { await fetch('http://127.0.0.1:4173/guest-exfil'); result.fetch = 'allowed' } catch { result.fetch = 'denied' }
        try { indexedDB.open('guest-exfil'); result.storage = 'allowed' } catch { result.storage = 'denied' }
        const remote = ['http://127.0.0.1:4173', 'guest-exfil.js'].join('/');
        try { await import(remote); result.import = 'allowed' } catch { result.import = 'denied' }
        try { new WebSocket('ws://127.0.0.1:4173/guest-exfil'); result.websocket = 'created' } catch { result.websocket = 'denied' }
        try { new Function('return 42')(); result.eval = 'allowed' } catch { result.eval = 'denied' }
        try { new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0])); result.wasm = 'allowed' } catch { result.wasm = 'denied' }
        console.log(JSON.stringify(result));
      `,
      },
    })
    const result = await workspace.execute('/test.ts')
    workspace.close()
    return result
  })
  expect(result.exitCode, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({
    origin: 'null',
    document: 'undefined',
    sharedMemory: 'undefined',
    fetch: 'denied',
    storage: 'denied',
    import: 'denied',
    eval: 'denied',
    wasm: 'allowed',
  })
  expect(responses).toEqual([])
  expect(failures).toHaveLength(requests.length)
  expect(failures.every((failure) => /csp/i.test(failure))).toBe(true)
})

test('separates concurrent workspaces and persists guest file writes', async ({
  page,
}) => {
  await page.goto('/sandbox.html')
  const result = await page.evaluate(async () => {
    const { Workspace } = window.sandboxLab
    const source = `import { readFile, writeFile } from 'node:fs/promises';
      const value = await readFile('/value.txt', 'utf8');
      await writeFile('/bytes.bin', new Uint8Array([0, 255, 128, 10]));
      console.log(value);`
    const a = new Workspace({
      files: { '/main.ts': source, '/value.txt': 'A' },
    })
    const b = new Workspace({
      files: { '/main.ts': source, '/value.txt': 'B' },
    })
    try {
      const outputs = await Promise.all([
        a.execute('/main.ts'),
        b.execute('/main.ts'),
      ])
      return {
        outputs,
        bytes: [...(await a.files.readFile('/bytes.bin'))],
        other: await b.files.readText('/value.txt'),
      }
    } finally {
      a.close()
      b.close()
    }
  })
  expect(result.outputs.map((output) => output.exitCode)).toEqual([0, 0])
  expect(result.outputs.map((output) => output.stdout)).toEqual(['A\n', 'B\n'])
  expect(result.bytes).toEqual([0, 255, 128, 10])
  expect(result.other).toBe('B')
})

test('kills runaway code and rejects read-only writes', async ({ page }) => {
  await page.goto('/sandbox.html')
  const result = await page.evaluate(async () => {
    const workspace = new window.sandboxLab.Workspace({
      files: {
        '/loop.ts': 'while (true) {}',
        '/write.ts': `import { writeFile } from 'node:fs/promises'; await writeFile('/forbidden', 'x')`,
        '/ok.ts': `console.log('still responsive')`,
      },
    })
    try {
      return {
        loop: await workspace.execute('/loop.ts', { timeoutMs: 150 }),
        readonly: await workspace.execute('/write.ts', { writable: false }),
        fileExists: await workspace.files.exists('/forbidden'),
        recovered: await workspace.execute('/ok.ts'),
      }
    } finally {
      workspace.close()
    }
  })
  expect(result.loop.stderr).toContain('Execution timed out')
  expect(result.readonly.stderr).toContain('EACCES')
  expect(result.fileExists).toBe(false)
  expect(result.recovered.stdout).toContain('still responsive')
})

test('checkpoints preserve binary files, links, and empty directories across a full page reload', async ({
  page,
}) => {
  await page.goto('/sandbox.html')
  await page.evaluate(async () => {
    const workspace = new window.sandboxLab.Workspace({
      files: {
        '/binary': new Uint8Array([255, 0, 192]),
        '/main.ts': 'console.log(42)',
      },
    })
    workspace.files.mkdirSync('/empty/nested',true)
    workspace.files.symlinkSync('main.ts','/alias.ts')
    await workspace.save('reload-test')
    workspace.close()
  })
  await page.reload()
  const result = await page.evaluate(async () => {
    const workspace = await window.sandboxLab.Workspace.open('reload-test')
    try {
      // Package staging must copy the entire snapshot, including links and dirs.
      await workspace.install({version:1,packages:[]})
      return {
        bytes: [...(await workspace.files.readFile('/binary'))],
        empty:workspace.files.isDirectorySync('/empty/nested'),
        entries:workspace.files.readdirSync('/empty/nested'),
        link:workspace.files.readlinkSync('/alias.ts'),
        execution: await workspace.execute('/alias.ts'),
      }
    } finally {
      workspace.close()
      await window.sandboxLab.checkpoint('delete', 'reload-test')
    }
  })
  expect(result.bytes).toEqual([255, 0, 192])
  expect(result.empty).toBe(true)
  expect(result.entries).toEqual([])
  expect(result.link).toBe('main.ts')
  expect(result.execution.stdout).toBe('42\n')
})

test('closing a workspace cancels a pending request', async ({ page }) => {
  await page.goto('/sandbox.html')
  const message = await page.evaluate(async () => {
    const workspace = new window.sandboxLab.Workspace({
      files: {
        '/server.ts': 'export default { fetch: () => new Promise(() => {}) }',
      },
    })
    const server = await workspace.serve('/server.ts')
    const pending = server
      .fetch('https://sandbox.invalid')
      .catch((error) => error.message)
    workspace.close()
    return pending
  })
  expect(message).toBe('Workspace closed')
})

test('downloads an integrity-pinned npm package and executes its CommonJS entry', async ({
  page,
}) => {
  await page.goto('/sandbox.html')
  const result = await page.evaluate(async () => {
    const metadata = await (
      await fetch('https://registry.npmjs.org/is-number/7.0.0')
    ).json()
    const workspace = new window.sandboxLab.Workspace({
      files: {
        '/main.ts': `import isNumber from 'is-number'; console.log(isNumber('42'), isNumber('no'))`,
      },
    })
    try {
      await workspace.install({
        version: 1,
        packages: [
          {
            installPath: '/node_modules/is-number',
            version: '7.0.0',
            resolved: metadata.dist.tarball,
            integrity: metadata.dist.integrity,
          },
        ],
      })
      const result = await workspace.execute('/main.ts')
      const vmResult = await workspace.executeInVM('/main.ts')
      // A package archive must not overwrite another workspace file through
      // pre-existing links, either at the package root or a final filename.
      await workspace.files.writeText('/private/package.json','safe')
      workspace.files.symlinkSync('/private','/node_modules/redirected')
      workspace.files.mkdirSync('/node_modules/linked-file')
      workspace.files.symlinkSync('/private/package.json','/node_modules/linked-file/package.json')
      const linkErrors:string[]=[]
      let linksUnchanged=true
      for(const installPath of ['/node_modules/redirected','/node_modules/linked-file']){
        const before=workspace.files.revision
        try{await workspace.install({version:1,packages:[{installPath,version:'7.0.0',resolved:metadata.dist.tarball,integrity:metadata.dist.integrity}]})}
        catch(error){linkErrors.push(String(error))}
        linksUnchanged&&=before===workspace.files.revision
      }
      const revision = workspace.files.revision
      let integrityError = ''
      try {
        await workspace.install({
          version: 1,
          packages: [
            {
              installPath: '/node_modules/bad',
              version: '7.0.0',
              resolved: metadata.dist.tarball,
              integrity: 'sha512-' + btoa('bad digest'),
            },
          ],
        })
      } catch (error) {
        integrityError = String(error)
      }
      return {
        result,
        vmResult,
        linkErrors,linksUnchanged,privateFile:await workspace.files.readText('/private/package.json'),
        integrityError,
        unchanged: revision === workspace.files.revision,
        packageFiles: (await workspace.files.list('/node_modules/is-number'))
          .length,
      }
    } finally {
      workspace.close()
    }
  })
  expect(result.result.exitCode, result.result.stderr).toBe(0)
  expect(result.result.stdout).toBe('true false\n')
  expect(result.vmResult.exitCode, result.vmResult.stderr).toBe(0)
  expect(result.vmResult.stdout).toBe('true false\n')
  expect(result.linkErrors).toHaveLength(2)
  expect(result.linkErrors.every(error=>error.includes('ELOOP'))).toBe(true)
  expect(result.linksUnchanged).toBe(true)
  expect(result.privateFile).toBe('safe')
  expect(result.packageFiles).toBeGreaterThan(1)
  expect(result.integrityError).toContain('integrity check')
  expect(result.unchanged).toBe(true)
})

test('builds two Vite projects concurrently without changing page globals', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await page.goto('/sandbox.html')
  const result = await page.evaluate(async () => {
    const before = ['Buffer', 'process', '__browserViteEngine'].map(
      (key) => key in window,
    )
    const engine = await window.sandboxLab.loadBrowserViteEngine()
    const outputs = await Promise.all(
      ['alpha', 'bravo'].map((marker) =>
        engine.runBrowserViteSmokeBuild({
          '/app/src/main.ts': `export const marker = '${marker}'`,
        }),
      ),
    )
    return {
      before,
      after: ['Buffer', 'process', '__browserViteEngine'].map(
        (key) => key in window,
      ),
      outputs: outputs.map((output) =>
        Object.values(output.files)
          .map((bytes) => new TextDecoder().decode(bytes))
          .join('\n'),
      ),
    }
  })
  expect(result.after).toEqual(result.before)
  expect(result.outputs[0]).toContain('alpha')
  expect(result.outputs[0]).not.toContain('bravo')
  expect(result.outputs[1]).toContain('bravo')
  expect(result.outputs[1]).not.toContain('alpha')
})

test('known gap: nested async branches do not have Node ALS semantics', async ({
  page,
}) => {
  await page.goto('/sandbox.html')
  const result = await page.evaluate(async () => {
    const workspace = new window.sandboxLab.Workspace({
      files: {
        '/test.ts': `
      import { AsyncLocalStorage } from 'node:async_hooks';
      const storage = new AsyncLocalStorage();
      const values = await Promise.all([
        storage.run('left', async () => { await new Promise(r => setTimeout(r, 10)); return storage.getStore() }),
        storage.run('right', async () => { await new Promise(r => setTimeout(r, 30)); return storage.getStore() }),
      ]);
      console.log(JSON.stringify(values));
    `,
      },
    })
    try {
      return await workspace.execute('/test.ts')
    } finally {
      workspace.close()
    }
  })
  expect(result.exitCode, result.stderr).toBe(0)
  test.fail(
    true,
    'Current ALS shim does not isolate concurrent nested stores. This is a release blocker for general Node compatibility.',
  )
  expect(JSON.parse(result.stdout)).toEqual(['left', 'right'])
})

test('reports unsupported subprocesses instead of simulating a shell', async ({
  page,
}) => {
  await page.goto('/sandbox.html')
  const result = await page.evaluate(async () => {
    const workspace = new window.sandboxLab.Workspace({
      files: {
        '/main.ts': `import { exec } from 'node:child_process'; exec('node -v')`,
      },
    })
    try {
      return await workspace.execute('/main.ts')
    } finally {
      workspace.close()
    }
  })
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain(
    "Unsupported Node builtin 'node:child_process'",
  )
})

test('probes opaque worker hosting under COOP and COEP', async ({
  page,
  browserName,
}, testInfo) => {
  await page.route(/^http:\/\/127\.0\.0\.1:4173\//, async (route) => {
    const response = await route.fetch()
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    })
  })
  await page.goto('/sandbox.html')
  const result = await page.evaluate(async () => {
    const workspace = new window.sandboxLab.Workspace({
      files: { '/main.ts': 'console.log(42)' },
    })
    try {
      return {
        isolated: crossOriginIsolated,
        execution: await workspace.execute('/main.ts'),
      }
    } finally {
      workspace.close()
    }
  })
  await testInfo.attach('isolated-hosting.json', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  })
  expect(result.isolated).toBe(true)
  // Pin observed behavior so an engine change is visible instead of silently changing our support claims.
  expect(result.execution.exitCode).toBe(browserName === 'webkit' ? 1 : 0)
})

test('runs the real Start SSR build inside the opaque workspace process', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000)
  // The pinned fixture must now build without a live package registry.
  await page.route('https://registry.npmjs.org/**', route => route.abort())
  await page.goto('/sandbox.html')
  const result = await page.evaluate(async () => {
    const build = await window.sandboxLab.buildStartFixtureInBrowser()
    const workspace = new window.sandboxLab.Workspace()
    try {
      const server = await workspace.serveCode(build.code, {
        timeoutMs: 10_000,
      })
      const response = await server.fetch('https://sandbox.invalid/')
      return {
        status: response.status,
        html: await response.text(),
        artifacts: Object.keys(build.artifacts),
        stderr: server.stderr,
      }
    } finally {
      workspace.close()
    }
  })
  await testInfo.attach('start-result.json', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  })
  expect(result.status, result.stderr).toBe(200)
  expect(result.html).toContain('Bare-bones Start')
  expect(result.html).toContain('Request context:')
})

test('negative control: Start hydration fails in the srcdoc preview', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/sandbox.html')
  await page.evaluate(async () => {
    const { Workspace, Preview, buildStartFixtureInBrowser } = window.sandboxLab
    const build = await buildStartFixtureInBrowser()
    const workspace = new Workspace({ files: build.artifacts })
    const server = await workspace.serveCode(build.code)
    const html = await (await server.fetch('https://sandbox.invalid/')).text()
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const src = doc
      .querySelector('script[type="module"][src]')!
      .getAttribute('src')!
    const client = await workspace.bundle('/app/dist/client' + src)
    await Preview.mount(
      document.querySelector('#preview')!,
      html,
      client.code,
      server,
    )
  })
  await page.waitForTimeout(300)
  await testInfo.attach('hydration-errors.json', {
    body: JSON.stringify(errors, null, 2),
    contentType: 'application/json',
  })
  expect(errors.join('\n')).toMatch(
    /history|replaceState|insecure|SecurityError/i,
  )
  test.fail(
    true,
    'The srcdoc preview cannot supply browser history and normal asset URLs required by Start.',
  )
  const button = page.frameLocator('#preview iframe').locator('#start-count')
  await button.click({ timeout: 2_000 })
  await expect(button).toHaveText('Count: 1', { timeout: 2_000 })
})

test('QuickJS probe denies ambient capabilities and interrupts CPU and allocation loops', async ({
  page,
}, testInfo) => {
  await page.goto('/sandbox.html')
  const result = await page.evaluate(async () => {
    const probe = window.sandboxLab.probeVM
    return {
      capabilities: await probe(
        `JSON.stringify({ fetch: typeof fetch, process: typeof process, indexedDB: typeof indexedDB, document: typeof document, Worker: typeof Worker })`,
      ),
      infinite: await probe('while (true) {}', { timeoutMs: 50 }),
      memory: await probe('"x".repeat(2 * 1024 * 1024)', {
        maxBytes: 1024 * 1024,
        timeoutMs: 1000,
      }),
      recovered: await probe('6 * 7'),
    }
  })
  await testInfo.attach('quickjs.json', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  })
  expect(result.capabilities.ok, JSON.stringify(result)).toBe(true)
  expect(Object.values(JSON.parse(result.capabilities.value))).toEqual(
    Array(5).fill('undefined'),
  )
  expect(result.infinite.ok).toBe(false)
  expect(JSON.stringify(result.infinite.value)).toContain('interrupted')
  expect(result.memory.ok).toBe(false)
  expect(JSON.stringify(result.memory.value)).toMatch(/memory/i)
  expect(result.recovered.value).toBe(42)
})

test('preview origin blocks parent access but does not promise to block self-navigation', async ({
  page,
}, testInfo) => {
  await page.goto('/sandbox.html')
  const response = page.waitForResponse('**/preview-navigation-probe*')
  await page.evaluate(async () => {
    const code = `
      let parentAccess;
      try { parent.document.body; parentAccess = 'allowed' } catch { parentAccess = 'denied' }
      document.querySelector('#access').textContent = parentAccess;
      document.querySelector('#leave').addEventListener('click', () => { location.href = 'http://127.0.0.1:4173/preview-navigation-probe?data=synthetic' });
    `
    const preview = await window.sandboxLab.Preview.mount(
      document.querySelector('#preview')!,
      '<output id="access"></output><button id="leave">Navigate</button>',
      code,
    )
    const state = await preview.inspect()
    if (!state.text.includes('denied'))
      throw new Error('Preview accessed the parent')
  })
  await page.frameLocator('#preview iframe').locator('#leave').click()
  const received = await response
  await testInfo.attach('preview-egress.json', {
    body: JSON.stringify({
      navigationReachedServer: true,
      status: received.status(),
    }),
    contentType: 'application/json',
  })
  expect(received.url()).toContain('data=synthetic')
})
