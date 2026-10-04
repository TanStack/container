import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdtempSync, cpSync, mkdirSync, symlinkSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { nativeReleaseAcceptanceIdentity } from './native-release-acceptance.mjs'
import { readPinnedNativeExamples } from './native-example-sources.mjs'
import { xtermLifecycleAssets } from './probe-xterm-release-lifecycle.mjs'

export function componentControlPlan(args, env = process.env) {
  assert.equal(args.length, 3, 'Pass SITE_FIXTURE INSTALLED_SDK DEPLOYMENT')
  const [fixture, sdk, deployment] = args.map(resolvePath => resolve(resolvePath))
  assert.match(fixture, /^\/private\/tmp\/tanstack-native-site-[A-Za-z0-9]+$/)
  const ports = [env.NATIVE_OWNER_PORT ?? '4357', env.NATIVE_SITE_PORT ?? '4358', env.NATIVE_PREVIEW_PORT ?? '4359'].map(value => {
    assert.match(value, /^\d+$/)
    const port = Number(value)
    assert.ok(port >= 1024 && port <= 65535)
    return port
  })
  assert.equal(new Set(ports).size, 3, 'Use three separate ports')
  const mode = env.NATIVE_COMPONENT_HOST ?? 'components'
  assert.ok(['components', 'workbench'].includes(mode), 'NATIVE_COMPONENT_HOST must be components or workbench')
  assert.ok(env.NATIVE_COMPONENT_INSPECT === undefined || ['0', '1'].includes(env.NATIVE_COMPONENT_INSPECT), 'NATIVE_COMPONENT_INSPECT must be 0 or 1')
  assert.ok(mode !== 'workbench' || env.NATIVE_COMPONENT_INSPECT === undefined, 'The real workbench owns its inspection polling')
  const xtermFixture = env.NATIVE_COMPONENT_XTERM_FIXTURE
  if (xtermFixture !== undefined) {
    assert.equal(mode, 'workbench', 'Terminal release comparison requires the actual workbench')
    assert.match(xtermFixture, /^\/private\/tmp\/native-xterm-release-[A-Za-z0-9]+$/)
  }
  return { fixture, sdk, deployment, owner: `http://127.0.0.1:${ports[0]}`,
    site: `http://127.0.0.1:${ports[1]}`, preview: `http://127.0.0.1:${ports[2]}`, inspect: mode === 'workbench' || env.NATIVE_COMPONENT_INSPECT === '1', mode,
    ...(xtermFixture === undefined ? {} : { xtermFixture }) }
}

export function componentControlInputs(plan, root) {
  const acceptance = nativeReleaseAcceptanceIdentity(root, plan.sdk, plan.deployment)
  const fixtureIdentity = JSON.parse(readFileSync(join(plan.fixture, '.native-local/identity.json')))
  assert.equal(fixtureIdentity.sdkSHA256, acceptance.sdkManifestSHA256, 'Fixture SDK identity differs')
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  const components = Object.fromEntries(['NativeTerminal.client.tsx', 'native-terminal-word.ts',
    'WebContainerTerminal.client.tsx', 'CodeMirrorEditor.client.tsx'].map(name => {
    const path = join(plan.fixture, 'src/components/examples', name)
    return [name, { path, sha256: hash(readFileSync(path)) }]
  }))
  if (plan.mode === 'workbench') {
    for (const filename of ['components/examples/ExampleNativeWorkbench.client.tsx', 'components/examples/SandboxBrowser.client.tsx',
      'components/ThemeProvider.tsx', 'components/FileExplorer.tsx', 'components/ButtonGroup.tsx', 'components/ds/ui/index.tsx',
      'ui/Tooltip.tsx', 'styles/app.css', 'utils/client-example-config.ts']) {
      const path = join(plan.fixture, 'src', filename)
      components[filename] = { path, sha256: hash(readFileSync(path)) }
    }
    assert.equal(components['components/examples/ExampleNativeWorkbench.client.tsx'].sha256,
      fixtureIdentity.integrations.find(item => item.filename === 'ExampleNativeWorkbench.client.tsx')?.sha256)
    assert.equal(components['components/examples/ExampleNativeWorkbench.client.tsx'].sha256,
      hash(readFileSync(join(root, 'integrations/tanstack-site/ExampleNativeWorkbench.client.tsx'))))
  }
  for (const name of ['NativeTerminal.client.tsx', 'native-terminal-word.ts']) {
    assert.equal(components[name].sha256, fixtureIdentity.integrations.find(item => item.filename === name)?.sha256,
      'Fixture component identity changed: ' + name)
    assert.equal(components[name].sha256, hash(readFileSync(join(root, 'integrations/tanstack-site', name))))
  }
  const examples = readPinnedNativeExamples(root)
  const example = examples.examples.get('react/start-counter')
  assert.ok(example)
  assert.equal(examples.manifestSHA256, fixtureIdentity.exampleManifestSHA256)
  const files = Object.fromEntries(Object.entries(example.files).map(([path, bytes]) => [path,
    typeof bytes === 'string' ? bytes : Array.from(bytes)]))
  return { acceptance, fixtureIdentity, components, project: { files },
    example: { revision: example.revision, sourceSHA256: example.sourceSHA256, npmLockSHA256: example.npmLockSHA256 } }
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const plan = componentControlPlan(process.argv.slice(2))
  const inputs = componentControlInputs(plan, root)
  let terminalRelease
  if (plan.xtermFixture) {
    const { packages } = xtermLifecycleAssets(plan.xtermFixture)
    assert.deepEqual(packages.map(item => item.version), ['6.0.0', '0.11.0'])
    const paths = ['package-lock.json', 'node_modules/@xterm/xterm/package.json',
      'node_modules/@xterm/xterm/lib/xterm.mjs', 'node_modules/@xterm/xterm/css/xterm.css',
      'node_modules/@xterm/addon-fit/package.json', 'node_modules/@xterm/addon-fit/lib/addon-fit.mjs']
    terminalRelease = { fixture: plan.xtermFixture, versions: packages.map(item => ({ name: item.name, version: item.version })),
      files: Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(join(plan.xtermFixture, path))).digest('hex')])) }
  }
  const directory = mkdtempSync('/private/tmp/native-reload-components-')
  const require = createRequire(join(plan.fixture, 'package.json'))
  const { createServer } = await import(pathToFileURL(require.resolve('vite')).href)
  const { default: react } = await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href)
  cpSync(join(root, 'integrations/native-reload-control', plan.mode === 'workbench' ? 'workbench.client.tsx' : 'client.tsx'), join(directory, 'client.tsx'))
  writeFileSync(join(directory, 'project.json'), JSON.stringify(inputs.project))
  writeFileSync(join(directory, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>Counter reload control</title>
    <style>html,body{margin:0;font:12px monospace;color:#111;background:#fff}*{box-sizing:border-box}
    header{height:42px;display:flex;align-items:center;gap:12px;padding:6px}button{font:inherit}
    .panels{display:flex;height:720px}.editor,.right{width:50%;min-width:0;min-height:0}.right{display:flex;flex-direction:column}
    .preview{flex:1;min-height:0}.preview iframe{display:block;width:100%;height:100%;border:0}
    [role=separator]{height:6px;flex-shrink:0;background:#ccc;cursor:row-resize}.terminal{min-height:0;flex-shrink:0}
    .size-full{width:100%;height:100%}.h-full{height:100%}.min-h-0{min-height:0}.owner{position:absolute;width:1px;height:1px;opacity:0}
    :root{--th-background:#fff;--th-token:#111;--font-ds-mono:monospace;--color-text-primary:#111;--color-background-default:#fff}</style></head>
    <body><div id="root"></div><script type="module" src="/client.tsx"></script></body></html>`)
  let workbenchPlugins = []
  if (plan.mode === 'workbench') {
    const { default: tailwind } = await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href)
    const startPackage = dirname(require.resolve('@tanstack/react-start/package.json'))
    const { tanstackStart } = await import(pathToFileURL(join(startPackage, 'dist/esm/plugin/vite.js')).href)
    // Reuse the private fixture's exact dependency graph, never reinstall or
    // modify it. Generated routes and the Vite cache belong to this new host.
    symlinkSync(join(plan.fixture, 'node_modules'), join(directory, 'node_modules'), 'dir')
    const dependencyNames = ['@tanstack/react-start', '@tanstack/react-router', 'react', 'react-dom']
    const dependencies = Object.fromEntries(dependencyNames.map(name => [name,
      JSON.parse(readFileSync(require.resolve(name + '/package.json'))).version]))
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies }))
    mkdirSync(join(directory, 'src/routes'), { recursive: true })
    for (const [template, target] of [
      ['workbench-root.tsx', 'src/routes/__root.tsx'],
      ['workbench-route.tsx', 'src/routes/start.latest.docs.framework.react.examples.start-counter.tsx'],
      ['workbench-router.tsx', 'src/router.tsx'],
      ['workbench-start.ts', 'src/start.ts'],
    ]) cpSync(join(root, 'integrations/native-reload-control', template), join(directory, target))
    writeFileSync(join(directory, 'control.css'), '@import "@control/styles";\n@source ' + JSON.stringify(join(plan.fixture, 'src')) + ';\n')
    const projectPath = join(plan.fixture, '.native-local/start-counter.json')
    const project = JSON.parse(readFileSync(projectPath))
    const entries = new Set([...Object.keys(project.files), ...Object.keys(project.binaryFiles)])
    assert.equal(entries.size, Object.keys(inputs.project.files).length)
    for (const [path, expected] of Object.entries(inputs.project.files)) {
      const actual = Object.hasOwn(project.files, path) ? Buffer.from(project.files[path]) : Buffer.from(project.binaryFiles[path], 'base64')
      assert.ok(actual.equals(Buffer.from(expected)), 'Workbench project differs from pinned source: ' + path)
    }
    workbenchPlugins = [tanstackStart(), tailwind(), {
      name: 'native-workbench-reload-project',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url ?? '/', 'http://127.0.0.1')
          if (url.pathname !== '/__native-local/project.json') return next()
          if (request.method !== 'GET' || url.searchParams.get('example') !== 'start-counter') { response.writeHead(404).end(); return }
          response.setHeader('Cache-Control', 'no-store'); response.setHeader('Content-Type', 'application/json')
          response.end(readFileSync(projectPath))
        })
      },
    }]
  }
  const receipt = { ...plan, directory, components: inputs.components, acceptance: inputs.acceptance, example: inputs.example,
    terminalRelease,
    clientSHA256: createHash('sha256').update(readFileSync(join(directory, 'client.tsx'))).digest('hex'),
    hostSources: Object.fromEntries(['scripts/serve-native-reload-components.mjs',
      ...(plan.mode === 'workbench' ? ['workbench-root.tsx', 'workbench-route.tsx', 'workbench-router.tsx', 'workbench-start.ts']
        .map(name => 'integrations/native-reload-control/' + name) : [])].map(name =>
      [name, createHash('sha256').update(readFileSync(join(root, name))).digest('hex')])) }
  writeFileSync(join(directory, 'identity.json'), JSON.stringify(receipt, null, 2) + '\n')
  const server = await createServer({ configFile: false, root: directory, envDir: directory,
    cacheDir: join(directory, 'vite-cache'), plugins: [...workbenchPlugins, react()],
    publicDir: plan.mode === 'workbench' ? join(plan.fixture, 'public') : false,
    resolve: { alias: [
      ...(terminalRelease ? [
        { find: '@xterm/xterm/css/xterm.css', replacement: join(plan.xtermFixture, 'node_modules/@xterm/xterm/css/xterm.css') },
        { find: /^@xterm\/xterm$/, replacement: join(plan.xtermFixture, 'node_modules/@xterm/xterm/lib/xterm.mjs') },
        { find: /^@xterm\/addon-fit$/, replacement: join(plan.xtermFixture, 'node_modules/@xterm/addon-fit/lib/addon-fit.mjs') },
      ] : []),
      ...Object.entries({
      ...(plan.mode === 'components' ? {
        react: dirname(require.resolve('react/package.json')),
        'react-dom': dirname(require.resolve('react-dom/package.json')),
      } : {}),
      '@control/sdk': join(plan.sdk, 'index.js'),
      '@control/terminal': inputs.components['NativeTerminal.client.tsx'].path,
      '@control/editor': inputs.components['CodeMirrorEditor.client.tsx'].path,
      ...(plan.mode === 'workbench' ? {
        '~': join(plan.fixture, 'src'),
        '@control/workbench': join(plan.fixture, 'src/components/examples/ExampleNativeWorkbench.client.tsx'),
        '@control/theme': join(plan.fixture, 'src/components/ThemeProvider.tsx'),
        '@control/styles': join(plan.fixture, 'src/styles/app.css'),
        '@tanstack/browser-sandbox-experimental': join(plan.sdk, 'index.js'),
      } : {}),
      }).map(([find, replacement]) => ({ find, replacement })),
    ] },
    define: { __RELOAD_CONTROL__: JSON.stringify({ owner: plan.owner, preview: plan.preview, buildId: inputs.acceptance.sdkManifestSHA256, inspect: plan.inspect }),
      ...(plan.mode === 'workbench' ? {
        'import.meta.env.VITE_NATIVE_OWNER_ORIGIN': JSON.stringify(plan.owner),
        'import.meta.env.VITE_NATIVE_PREVIEW_ORIGIN': JSON.stringify(plan.preview),
        'import.meta.env.VITE_NATIVE_SDK_BUILD_ID': JSON.stringify(inputs.acceptance.sdkManifestSHA256),
      } : {}),
    },
    server: { host: '127.0.0.1', port: Number(new URL(plan.site).port), strictPort: true,
      fs: { allow: [directory, plan.fixture, dirname(plan.sdk), ...(plan.xtermFixture ? [plan.xtermFixture] : [])] },
      headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'no-store' } },
  })
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NATIVE_')))
  const owner = spawn(process.execPath, [join(root, 'scripts/local-native-site-host.mjs')], { env: { ...clean,
    NATIVE_SITE_ORIGIN: plan.site, NATIVE_OWNER_ORIGIN: plan.owner, NATIVE_PREVIEW_ORIGIN: plan.preview,
    NATIVE_SDK_BUNDLE_DIR: plan.sdk, NATIVE_DEPLOYMENT_DIR: plan.deployment }, stdio: ['ignore', 'pipe', 'inherit'] })
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    owner.kill('SIGTERM')
    await server.close()
  }
  process.once('SIGINT', () => { void close() })
  process.once('SIGTERM', () => { void close() })
  owner.once('exit', code => { if (!closing) { process.exitCode = code || 1; void close() } })
  try {
    await new Promise((resolveReady, reject) => {
      let text = ''
      const timer = setTimeout(() => reject(Error('Owner host did not start')), 15000)
      owner.once('error', error => { clearTimeout(timer); reject(error) })
      owner.once('exit', () => { clearTimeout(timer); reject(Error('Owner host exited during startup')) })
      owner.stdout.on('data', bytes => {
        text = (text + bytes).slice(-4096)
        if (text.includes(`Native owner ${plan.owner} and preview ${plan.preview}`)) { clearTimeout(timer); resolveReady() }
      })
    })
    await server.listen()
    console.log('Component reload control ' + plan.site + ', receipt ' + join(directory, 'identity.json'))
  } catch (error) { await close(); throw error }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
