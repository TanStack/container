import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstatSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { componentControlInputs } from './serve-native-reload-components.mjs'
import { nativeSiteProjectInputs } from './native-site-project-inputs.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const browsers = ['chromium', 'firefox', 'webkit']
const milestones = ['Counter click passed', 'Live edit passed', 'Run restarted edited app',
  'Reload started a fresh example', 'Basic SSR, binary asset, deferred server functions, hydration, navigation and live edit passed',
  'Router Express SSR, hydration, post navigation and live edit passed', 'Both Start streaming buttons delivered early chunks']

function origin(value) {
  const url = new URL(value)
  assert.equal(url.origin, value, 'Pass a plain loopback origin')
  assert.equal(url.protocol, 'http:')
  assert.equal(url.hostname, '127.0.0.1')
  assert.ok(Number(url.port) >= 1024 && Number(url.port) <= 65535)
  return value
}

export function siteRepeatOptions(args) {
  const [fixture, sdk, deployment, ...flags] = args
  assert.ok(fixture && sdk && deployment, 'Pass SITE_FIXTURE INSTALLED_SDK DEPLOYMENT')
  assert.equal(flags.length % 2, 0)
  const options = { fixture: resolve(fixture), sdk: resolve(sdk), deployment: resolve(deployment),
    site: 'http://127.0.0.1:4408', preview: 'http://127.0.0.1:4409', browser: 'firefox', runs: 3 }
  assert.match(options.fixture, /^\/private\/tmp\/tanstack-native-site-[A-Za-z0-9]+$/)
  const seen = new Set()
  for (let i = 0; i < flags.length; i += 2) {
    const key = flags[i]
    assert.ok(['--site', '--preview', '--browser', '--runs', '--runner'].includes(key) && !seen.has(key), 'Unknown or repeated option')
    seen.add(key); options[key.slice(2)] = flags[i + 1]
  }
  assert.ok(/^[1-5]$/.test(String(options.runs)), 'Runs must be 1..5')
  options.runs = Number(options.runs)
  assert.ok(browsers.includes(options.browser) || options.browser === 'all', 'Unknown browser')
  origin(options.site); origin(options.preview)
  assert.notEqual(options.site, options.preview)
  if (options.runner !== undefined) {
    assert.ok(options.runner.length && options.runner.startsWith('/'), 'Runner must be an absolute directory')
    options.runner = resolve(options.runner)
    assert.notEqual(options.runner, '/', 'Runner cannot be the filesystem root')
  }
  return options
}

export function siteRepeatRunner(options, projectRoot = root) {
  const directory = options.runner ?? projectRoot
  const paths = ['scripts/test-local-native-site.mjs', 'scripts/native-site-streaming-observation.mjs',
    'scripts/native-browser-diagnostic.mjs', 'scripts/native-start-example-readiness.mjs',
    'scripts/native-preview-navigation-errors.mjs']
  const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
  const hashes = Object.fromEntries(paths.map(path => {
    const copied = join(directory, path)
    const stat = lstatSync(copied)
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Runner source must be a regular file: ' + path)
    const actual = hash(copied)
    assert.equal(actual, hash(join(projectRoot, path)), 'Runner source differs: ' + path)
    return [path, actual]
  }))
  const packages = Object.fromEntries(['@playwright/test', 'playwright', 'playwright-core'].map(name => {
    const path = join(directory, 'node_modules', name, 'package.json')
    const metadata = JSON.parse(readFileSync(path))
    assert.equal(metadata.name, name, 'Runner package name differs')
    assert.match(metadata.version, /^\d+\.\d+\.\d+$/, 'Use a released browser runner')
    return [name, { version: metadata.version, sha256: hash(path) }]
  }))
  assert.equal(new Set(Object.values(packages).map(item => item.version)).size, 1, 'Browser runner packages must match')
  const dependencyRoot = dirname(realpathSync(join(directory, 'node_modules')))
  const lockPath = join(dependencyRoot, 'package-lock.json')
  const lock = JSON.parse(readFileSync(lockPath))
  for (const [name, metadata] of Object.entries(packages))
    assert.equal(lock.packages?.['node_modules/' + name]?.version, metadata.version, 'Actual browser runner lock differs: ' + name)
  return { directory, entrypoint: join(directory, paths[0]), hashes, packages, dependencyRoot,
    runnerLockSHA256: hash(lockPath), browserCatalogSHA256: hash(join(directory, 'node_modules/playwright-core/browsers.json')) }
}

export function siteRepeatInputs(options, projectRoot = root) {
  const inputs = componentControlInputs({ ...options, mode: 'workbench' }, projectRoot)
  const hashes = Object.fromEntries(['scripts/repeat-local-native-site.mjs', 'scripts/test-local-native-site.mjs',
    'scripts/native-site-streaming-observation.mjs', 'scripts/native-browser-diagnostic.mjs',
    'scripts/native-start-example-readiness.mjs',
    'scripts/native-preview-navigation-errors.mjs', 'scripts/native-site-project-inputs.mjs',
    'scripts/native-example-sources.mjs'].map(path => [path,
    createHash('sha256').update(readFileSync(join(projectRoot, path))).digest('hex')]))
  const siteHashes = Object.fromEntries(['package.json', 'pnpm-lock.yaml', '.native-local/identity.json'].map(path => [path,
    createHash('sha256').update(readFileSync(join(options.fixture, path))).digest('hex')]))
  return { acceptance: inputs.acceptance, components: inputs.components, example: inputs.example,
    fixtureIdentity: inputs.fixtureIdentity, hashes, siteHashes,
    projectHashes: nativeSiteProjectInputs(options.fixture, projectRoot, inputs.acceptance.sdkManifestSHA256),
    runner: siteRepeatRunner(options, projectRoot) }
}

export function runSiteRepeats(options, { projectRoot = root, run = spawnSync, inputs = siteRepeatInputs, env = process.env } = {}) {
  const identity = inputs(options, projectRoot)
  const output = mkdtempSync(join(tmpdir(), 'native-site-streaming-repeats-'))
  const plannedBrowsers = options.browser === 'all' ? browsers : [options.browser]
  const rows = []
  let failed = false
  for (const browser of plannedBrowsers) {
    for (let iteration = 1; iteration <= options.runs; iteration++) {
      const basename = `${browser}-${iteration}`
      const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('LOCAL_NATIVE_')))
      Object.assign(childEnv, { NATIVE_TEST_BROWSER: browser, NATIVE_SITE_ORIGIN: options.site,
        NATIVE_PREVIEW_ORIGIN: options.preview, LOCAL_NATIVE_TRACE_STREAMING: '1',
        LOCAL_NATIVE_FAILURE_REPORT: join(output, basename + '-failure.json'),
        LOCAL_NATIVE_FAILURE_CAPTURE: join(output, basename + '-failure.png') })
      console.log('NATIVE_SITE_REPEAT_START ' + JSON.stringify({ browser, iteration, runs: options.runs, output }))
      const started = performance.now()
      const child = run(process.execPath, [identity.runner?.entrypoint ?? join(projectRoot, 'scripts/test-local-native-site.mjs')], {
        cwd: projectRoot, env: childEnv, stdio: 'pipe', encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
        timeout: 15 * 60 * 1000,
      })
      const log = String(child.stdout ?? '') + String(child.stderr ?? '')
      const logPath = join(output, basename + '.log')
      writeFileSync(logPath, log, { flag: 'wx' })
      let observations = [], inputError, parseError
      try { assert.deepEqual(inputs(options, projectRoot), identity, 'Repeat inputs changed') }
      catch (error) { inputError = error.message }
      try {
        observations = log.split('\n').filter(line => line.startsWith('NATIVE_SITE_STREAM_OBSERVATION '))
          .map(line => JSON.parse(line.slice('NATIVE_SITE_STREAM_OBSERVATION '.length)))
      } catch (error) { parseError = error.message }
      const complete = milestones.every(text => log.split('\n').filter(line => line === `${browser}: ${text}`).length === 1)
      const observed = observations.length === 1 && observations[0].browser === browser && observations[0].buttons?.length === 2 &&
        observations[0].buttons.every(button => {
          const nonempty = button.rows?.filter(row => row.numbers?.length)
          return nonempty?.length > 1 && nonempty[0].numbers.includes(1) && !nonempty[0].numbers.includes(10) &&
            nonempty.at(-1).numbers.includes(10)
        })
      const row = { browser, iteration, exitCode: child.status, signal: child.signal, error: child.error?.message,
        inputError, parseError, elapsedMs: Math.round(performance.now() - started), complete,
        passed: child.status === 0 && !child.signal && !child.error && !inputError && !parseError && complete && observed,
        observations, log: logPath }
      rows.push(row)
      writeFileSync(join(output, basename + '.json'), JSON.stringify(row, null, 2) + '\n', { flag: 'wx' })
      console.log('NATIVE_SITE_REPEAT ' + JSON.stringify({ ...row, observations: undefined }))
      if (!row.passed) { failed = true; break }
    }
    if (failed) break
  }
  const report = { scope: 'All four pinned real-site examples: Counter/live-edit/restart/reload, Basic SSR/binary/deferred server functions/navigation/edit, Router Express SSR/post navigation/edit and both progressive streaming buttons. Strict host error gate, no production or expanded-terminal acceptance.',
    plannedBrowsers, runs: options.runs, identity, output, rows,
    passed: rows.length === plannedBrowsers.length * options.runs && rows.every(row => row.passed) }
  writeFileSync(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.log('NATIVE_SITE_REPEAT_REPORT ' + join(output, 'results.json'))
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runSiteRepeats(siteRepeatOptions(process.argv.slice(2)))
  if (!report.passed) process.exitCode = 1
}
