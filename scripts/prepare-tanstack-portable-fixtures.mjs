#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const router = resolve(process.argv[2] ?? join(repository, '../router'))
const fixtureRoot = resolve(process.argv[3] ?? join(repository, 'fixtures'))
const rolldownVersion = '1.2.9'
const lightningcssVersion = '1.33.0'
const examples = [
  { id: 'start-counter', source: 'start-counter' },
  { id: 'start-basic', source: 'start-basic', tailwindLightningcssVersion: '1.32.0', tailwindOxideVersion: '4.2.2', nitroVersion: '3.0.260903-beta' },
  { id: 'start-streaming-data-from-server-functions', source: 'start-streaming-data-from-server-functions' },
  { id: 'basic-ssr-file-based', source: 'basic-ssr-file-based' },
]
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

for (const example of examples) {
  const sourceDirectory = join(router, 'examples/react', example.source)
  const sourceBytes = readFileSync(join(sourceDirectory, 'package.json'))
  const original = JSON.parse(sourceBytes)
  const dependencies = {
    ...original.dependencies,
    '@rolldown/binding-wasm32-wasi': rolldownVersion,
    lightningcss: `npm:lightningcss-wasm@${lightningcssVersion}`,
    ...(example.tailwindOxideVersion
      ? { '@tailwindcss/oxide-wasm32-wasi': example.tailwindOxideVersion }
      : {}),
  }
  const overrides = {
    ...(original.overrides ?? {}),
    rolldown: rolldownVersion,
    ...(example.tailwindLightningcssVersion
      ? { '@tailwindcss/node': { lightningcss: `npm:lightningcss-wasm@${example.tailwindLightningcssVersion}` } }
      : { lightningcss: `npm:lightningcss-wasm@${lightningcssVersion}` }),
  }
  const devDependencies = {
    ...original.devDependencies,
    ...(example.nitroVersion ? { nitro: example.nitroVersion } : {}),
  }
  const portable = { ...original, dependencies, devDependencies, overrides }
  const destination = join(fixtureRoot, `site-${example.id}-portable`)
  mkdirSync(destination, { recursive: true })
  writeFileSync(join(destination, 'package.json'), `${JSON.stringify(portable, null, 2)}\n`)
  writeFileSync(join(destination, 'LICENSE'), readFileSync(join(router, 'LICENSE')))
  const graphChanges = {
    dependencies: Object.fromEntries(
      Object.entries(dependencies).filter(([name, value]) => original.dependencies?.[name] !== value),
    ),
    devDependencies: Object.fromEntries(
      Object.entries(devDependencies).filter(([name, value]) => original.devDependencies?.[name] !== value),
    ),
    overrides,
  }
  writeFileSync(join(destination, 'provenance.json'), `${JSON.stringify({
    source: `TanStack/router/examples/react/${example.source}/package.json`,
    sourceSHA256: sha256(sourceBytes),
    lockCommand: 'npm install --package-lock-only --ignore-scripts --no-audit --no-fund --force',
    dependencySubstitutions: true,
    graphChanges,
    env: {
      CI: 'true',
      NAPI_RS_WASI_FLAVOR: 'wasm32-wasi',
      NAPI_RS_FORCE_WASI: 'error',
      NAPI_RS_ENFORCE_VERSION_CHECK: '1',
      ...(example.id.startsWith('start-') ? { NITRO_DEV_RUNNER: 'self' } : {}),
    },
  }, null, 2)}\n`)
  const install = spawnSync('npm', [
    'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--force',
  ], {
    cwd: destination,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_cache: join(fixtureRoot, '.npm-cache'),
      npm_config_update_notifier: 'false',
    },
  })
  if (install.status !== 0) throw Error(`Could not lock ${example.id}\n${install.stdout}${install.stderr}`)
  process.stdout.write(`${example.id}: ${destination}\n`)
}
