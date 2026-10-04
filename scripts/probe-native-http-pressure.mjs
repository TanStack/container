import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {readFileSync, writeFileSync, mkdtempSync} from 'node:fs'
import {createRequire} from 'node:module'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {nativeReleaseAcceptanceIdentity} from './native-release-acceptance.mjs'
import {nativeSDKCheckEnvironment} from './check-native-sdk.mjs'

export function readHTTPPressureResults(output, installed) {
  const rows = String(output).split('\n').flatMap(line => {
    try { const row = JSON.parse(line); return typeof row.browser === 'string' ? [row] : [] } catch { return [] }
  })
  assert.deepEqual(rows.map(row => row.browser), ['chromium', 'firefox', 'webkit'], 'Require all three engines exactly once')
  for (const row of rows) {
    assert.equal(row.passed, true)
    assert.ok(typeof row.version === 'string' && row.version.length > 0)
    if (installed) {
      assert.equal(row.result.cancelled, 32)
      assert.equal(row.result.responses, 96)
      assert.equal(row.result.state.received, 128)
      assert.equal(row.result.state.finished, 96)
      assert.equal(row.result.state.held, 32)
      assert.equal(row.result.resources.responseStreams, 0)
      assert.equal(row.result.resources.sockets, 0)
      assert.deepEqual(row.result.diagnostics, [])
    } else {
      assert.equal(row.held, 32)
      assert.equal(row.completed, 96)
      assert.equal(row.responseBytes, 300 * 1024)
      assert.equal(row.handles, 0)
    }
  }
  return rows
}

export function probeNativeHTTPPressure(sdk, deployment, runnerRoot = process.cwd()) {
  const root = fileURLToPath(new URL('..', import.meta.url))
  sdk = resolve(sdk); deployment = resolve(deployment); runnerRoot = resolve(runnerRoot)
  const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
  const paths = ['tests/native-http-pressure-browser.test.mjs', 'tests/native-owner-http-pressure.test.mjs',
    'tests/fixtures/native-http-pressure.mjs', 'scripts/sdk-browser-assets.mjs']
  const identity = () => {
    const copied = Object.fromEntries(paths.map(path => {
      const value = hash(join(root, path))
      assert.equal(hash(join(runnerRoot, path)), value, 'Runner differs from current source: ' + path)
      return [path, value]
    }))
    const require = createRequire(join(runnerRoot, 'package.json'))
    return {acceptance: nativeReleaseAcceptanceIdentity(root, sdk, deployment), copied,
      browserPackage: require('@playwright/test/package.json').version,
      browserLockSHA256: hash(join(runnerRoot, 'package-lock.json')),
      driverSHA256: hash(fileURLToPath(import.meta.url)),
      sourceLocks: {npm: hash(join(root, 'package-lock.json')), pnpm: hash(join(root, 'pnpm-lock.yaml'))},
      node: process.version}
  }
  const before = identity(), directory = mkdtempSync(join(tmpdir(), 'native-http-pressure-results-'))
  const result = {scope: 'Node reference, guest HTTP and installed owner pressure controls, not Vite app or alpha acceptance.',
    identity: before, rows: [], passed: false}
  const save = () => writeFileSync(join(directory, 'results.json'), JSON.stringify(result, null, 2) + '\n')
  console.log('HTTP pressure receipt: ' + join(directory, 'results.json')); save()
  for (const installed of [false, true]) {
    const name = installed ? 'installed-owner' : 'guest-http', started = Date.now()
    const file = installed ? 'tests/native-owner-http-pressure.test.mjs' : 'tests/native-http-pressure-browser.test.mjs'
    const child = spawnSync(process.execPath, ['--test', '--test-force-exit', '--test-timeout=90000', join(runnerRoot, file)],
      {cwd: runnerRoot, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 120000,
        env: {...nativeSDKCheckEnvironment(), NATIVE_SOURCE_ROOT: root, NATIVE_SDK_BUNDLE_DIR: sdk,
          NATIVE_DEPLOYMENT_DIR: deployment,
          [installed ? 'NATIVE_OWNER_HTTP_PRESSURE' : 'NATIVE_HTTP_PRESSURE_CONTROL']: '1'}})
    const output = (child.stdout ?? '') + '\n' + (child.stderr ?? '')
    writeFileSync(join(directory, name + '.log'), output, {flag: 'wx'})
    const row = {name, status: child.status, signal: child.signal, elapsedMs: Date.now() - started,
      error: child.error ? String(child.error) : undefined, passed: false}
    try {
      assert.equal(child.status, 0, 'Pressure control failed')
      assert.equal(child.error, undefined)
      row.browsers = readHTTPPressureResults(output, installed)
      assert.deepEqual(identity(), before, 'Pressure control inputs changed')
      row.passed = true
    } catch (error) { row.validationError = String(error) }
    result.rows.push(row); save(); console.log(JSON.stringify(row))
    if (!row.passed) break
  }
  result.passed = result.rows.length === 2 && result.rows.every(row => row.passed); save()
  return {directory, result}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.length === 4 || process.argv.length === 5,
    'Usage: node scripts/probe-native-http-pressure.mjs INSTALLED_SDK DEPLOYMENT [RUNNER_ROOT]')
  if (!probeNativeHTTPPressure(...process.argv.slice(2)).result.passed) process.exitCode = 1
}
