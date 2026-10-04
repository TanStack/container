import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname, relative, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readPinnedNativeExamples } from './native-example-sources.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const replaceOnce = (source, before, after) => {
  assert.equal(source.split(before).length, 2, 'Site integration anchor changed: ' + before)
  return source.replace(before, after)
}

export function prepareNativeSiteFixture(site, sdk) {
  site = resolve(site)
  sdk = resolve(sdk)
  const sdkInventoryBytes = readFileSync(join(sdk, 'package-assets.json'))
  const sdkInventory = JSON.parse(sdkInventoryBytes)
  for (const entry of sdkInventory.files) {
    const filename = resolve(sdk, entry.path)
    const name = relative(sdk, filename)
    assert.ok(name && !name.startsWith('..') && !isAbsolute(name))
    const bytes = readFileSync(filename)
    assert.equal(bytes.length, entry.bytes, 'Installed SDK file size changed: ' + name)
    assert.equal(hash(bytes), entry.sha256, 'Installed SDK file changed: ' + name)
  }
  const sdkSHA256 = hash(sdkInventoryBytes)
  const sourceRevision = execFileSync('git', ['-C', site, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const filenames = execFileSync('git', ['-C', site, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean).sort()
  const fixture = mkdtempSync('/private/tmp/tanstack-native-site-')
  const sourceHash = createHash('sha256')
  let copiedFiles = 0
  for (const filename of filenames) {
    // Credentials and generated persistence do not belong in a test fixture.
    if (filename === 'AGENTS.md' || filename === 'CLAUDE.md' || filename.split('/').some(part => /^(?:\.git|\.claude|\.agents|\.codex|node_modules|\.wrangler|\.env(?:\..*)?|\.dev\.vars(?:\..*)?|\.npmrc|\.yarnrc(?:\..*)?)$/.test(part))) continue
    const source = join(site, filename)
    const stat = lstatSync(source)
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Expected tracked regular file: ' + filename)
    const bytes = readFileSync(source)
    sourceHash.update(filename).update('\0').update(bytes).update('\0')
    const target = join(fixture, filename)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(source, target)
    copiedFiles++
  }
  const templates = join(root, 'integrations/tanstack-site')
  const workbenchPath = join(fixture, 'src/components/examples/ExampleWorkbench.client.tsx')
  let workbench = readFileSync(workbenchPath, 'utf8')
  workbench = replaceOnce(workbench, 'export function ExampleWorkbench({', 'function OriginalExampleWorkbench({')
  const ids = {
    'start-react-start-counter': 'start-counter',
    'start-react-start-basic': 'start-basic',
    'start-react-start-streaming-data-from-server-functions': 'start-streaming-data-from-server-functions',
    'router-react-basic-ssr-file-based': 'basic-ssr-file-based',
  }
  const wrapper = `import { ExampleNativeWorkbench } from './ExampleNativeWorkbench.client'\n` +
    `const nativeExampleIds: Record<string, string> = ${JSON.stringify(ids, null, 2)}\n` +
    `export function ExampleWorkbench(props: React.ComponentProps<typeof OriginalExampleWorkbench>) {\n` +
    `  const exampleId = nativeExampleIds[props.definition.id]\n` +
    `  if (import.meta.env.DEV && import.meta.env.VITE_LOCAL_NATIVE_SANDBOX === '1' && exampleId && props.definition.runtime?.type === 'webcontainer')\n` +
    `    return <ExampleNativeWorkbench definition={props.definition} exampleId={exampleId} />\n` +
    `  return <OriginalExampleWorkbench {...props} />\n}\n`
  writeFileSync(workbenchPath, wrapper + workbench)
  for (const filename of ['ExampleNativeWorkbench.client.tsx', 'NativeTerminal.client.tsx', 'native-terminal-word.ts'])
    cpSync(join(templates, filename), join(fixture, 'src/components/examples', filename))
  const terminalPath = join(fixture, 'src/components/examples/WebContainerTerminal.client.tsx')
  writeFileSync(terminalPath, replaceOnce(readFileSync(terminalPath, 'utf8'),
    'function readTerminalTheme(container: HTMLElement)',
    'export function readTerminalTheme(container: HTMLElement)'))
  cpSync(join(templates, 'local-native-examples.mjs'), join(fixture, 'scripts/local-native-examples.mjs'))
  const configPath = join(fixture, 'vite.config.ts')
  let config = readFileSync(configPath, 'utf8')
  config = "import { localNativeExamples } from './scripts/local-native-examples.mjs'\n" + config
  config = replaceOnce(config, "'~': path.resolve(__dirname, './src'),", "'~': path.resolve(__dirname, './src'),\n        '@tanstack/browser-sandbox-experimental': " + JSON.stringify(join(sdk, 'index.js')) + ',')
  config = replaceOnce(config, 'plugins: [', 'plugins: [\n      localNativeExamples(),')
  writeFileSync(configPath, config)
  const headersPath = join(fixture, 'src/utils/stackblitz-embed.ts')
  writeFileSync(headersPath, replaceOnce(readFileSync(headersPath, 'utf8'),
    'export const webContainerHeaders = stackBlitzEmbedHeaders',
    "export const webContainerHeaders = import.meta.env.VITE_LOCAL_NATIVE_SANDBOX === '1'\n  ? { ...stackBlitzEmbedHeaders, 'Cross-Origin-Embedder-Policy': 'require-corp' }\n  : stackBlitzEmbedHeaders"))
  const routePath = join(fixture, 'src/routes/_library/$libraryId/$version.docs.framework.$framework.examples.$.tsx')
  const nativeHeaders = "...getExampleRuntimeHeaders(\n" +
    "        import.meta.env.DEV && import.meta.env.VITE_LOCAL_NATIVE_SANDBOX === '1' &&\n" +
    '        [' + Object.keys(ids).map(id => "'" + id + "'").join(', ') + '].includes(\n' +
    "          [params.libraryId, params.framework, params._splat].join('-'),\n" +
    "        ) ? 'webcontainer' : 'external',\n" +
    '      ),'
  const route = replaceOnce(readFileSync(routePath, 'utf8'),
    '// Every example offers an external editor, including esbuild examples.',
    "// Local native examples need the native owner's isolation policy.")
  writeFileSync(routePath, replaceOnce(route,
    "...getExampleRuntimeHeaders('external'),", nativeHeaders))
  const pinned = readPinnedNativeExamples(root)
  mkdirSync(join(fixture, '.native-local'))
  const tsconfig = JSON.parse(readFileSync(join(fixture, 'tsconfig.json'), 'utf8'))
  const sdkPackage = JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8'))
  writeFileSync(join(fixture, '.native-local/typecheck.json'), JSON.stringify({
    extends: '../tsconfig.json',
    compilerOptions: { paths: {
      ...tsconfig.compilerOptions.paths,
      '~/*': ['../src/*'],
      'content-collections': ['../.content-collections/generated'],
      '@tanstack/browser-sandbox-experimental': [join(sdk, sdkPackage.types)],
    } },
  }, null, 2) + '\n')
  for (const example of Object.values(ids)) {
    const source = pinned.examples.get('react/' + example)
    assert.ok(source, 'Missing pinned example: ' + example)
    const files = {}, binaryFiles = {}
    for (const [filename, contents] of Object.entries(source.files)) {
      const bytes = Buffer.from(contents)
      const text = typeof contents === 'string' ? contents : bytes.toString('utf8')
      if (typeof contents === 'string' || (Buffer.from(text).equals(bytes) && !text.includes('\0'))) files[filename] = text
      else binaryFiles[filename] = bytes.toString('base64')
    }
    const identity = hash(JSON.stringify([source.sourceSHA256, source.npmLockSHA256, sdkSHA256]))
    writeFileSync(join(fixture, '.native-local', example + '.json'), JSON.stringify({ files, binaryFiles, identity, sourceRevision: source.revision, sourceSHA256: source.sourceSHA256, npmLockSHA256: source.npmLockSHA256 }))
  }
  const integrationFiles = ['ExampleNativeWorkbench.client.tsx', 'NativeTerminal.client.tsx', 'native-terminal-word.ts', 'local-native-examples.mjs']
  const result = {
    fixture, site, sourceRevision, copiedFiles, sourceSHA256: sourceHash.digest('hex'),
    sdk, sdkSHA256, exampleManifestSHA256: pinned.manifestSHA256,
    integrations: integrationFiles.map(filename => ({ filename, sha256: hash(readFileSync(join(templates, filename))) })),
    modifications: ['dev-only workbench selection for four full environments', 'installed SDK alias', 'local pinned example middleware', 'native owner COEP headers selected by the four native example routes', 'reuse exported site terminal theme reader'],
  }
  writeFileSync(join(fixture, '.native-local', 'identity.json'), JSON.stringify(result, null, 2) + '\n')
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [site, sdk, ...extra] = process.argv.slice(2)
  assert.ok(site && sdk && !extra.length, 'Usage: node scripts/prepare-native-site-fixture.mjs SITE_CHECKOUT INSTALLED_SDK')
  console.log(JSON.stringify(prepareNativeSiteFixture(site, sdk), null, 2))
}
