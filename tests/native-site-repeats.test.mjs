import assert from 'node:assert/strict'
import test from 'node:test'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { siteRepeatOptions, siteRepeatRunner, runSiteRepeats } from '../scripts/repeat-local-native-site.mjs'

const args = ['/private/tmp/tanstack-native-site-test', '/private/tmp/sdk-test', '/private/tmp/deployment-test']
const log = browser => ['Counter click passed', 'Live edit passed', 'Run restarted edited app',
  'Reload started a fresh example', 'Basic SSR, binary asset, deferred server functions, hydration, navigation and live edit passed',
  'Router Express SSR, hydration, post navigation and live edit passed', 'Both Start streaming buttons delivered early chunks'].map(text => `${browser}: ${text}`).join('\n') +
  '\nNATIVE_SITE_STREAM_OBSERVATION ' + JSON.stringify({ browser, buttons: [0, 1].map(() => ({
    rows: [{ numbers: [1] }, { numbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }],
  })) }) + '\n'

test('site repeat plan rejects unbounded, empty, duplicate and non-loopback selections', () => {
  const options = siteRepeatOptions(args)
  assert.equal(options.runs, 3)
  assert.equal(options.browser, 'firefox')
  for (const flags of [['--runs', '0'], ['--runs', '6'], ['--runs', '1.5'], ['--browser', ''],
    ['--browser', 'safari'], ['--site', 'https://example.com'], ['--site', 'http://127.0.0.1:4408/path'],
    ['--preview', 'http://127.0.0.1:4408'], ['--runs', '1', '--runs', '2'], ['--unknown', '1'], ['--runs'],
    ['--runner', ''], ['--runner', './relative'], ['--runner', '/']])
    assert.throws(() => siteRepeatOptions([...args, ...flags]))
})

test('external site runner requires unchanged sources and matching released browser packages', () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-site-runner-check-'))
  const paths = ['test-local-native-site.mjs', 'native-site-streaming-observation.mjs',
    'native-browser-diagnostic.mjs', 'native-start-example-readiness.mjs', 'native-preview-navigation-errors.mjs']
  mkdirSync(join(directory, 'scripts'))
  for (const name of paths)
    copyFileSync(new URL('../scripts/' + name, import.meta.url), join(directory, 'scripts', name))
  const packagePath = name => join(directory, 'node_modules', name, 'package.json')
  for (const name of ['@playwright/test', 'playwright', 'playwright-core']) {
    mkdirSync(join(directory, 'node_modules', name), { recursive: true })
    writeFileSync(packagePath(name), JSON.stringify({ name, version: '1.63.0' }))
  }
  const lock={packages:Object.fromEntries(['@playwright/test','playwright','playwright-core'].map(name=>
    ['node_modules/'+name,{version:'1.63.0'}]))}
  writeFileSync(join(directory,'package-lock.json'),JSON.stringify(lock))
  writeFileSync(join(directory,'node_modules/playwright-core/browsers.json'),'{}')
  const options = siteRepeatOptions([...args, '--runner', directory])
  const runner = siteRepeatRunner(options)
  assert.equal(runner.entrypoint, join(directory, 'scripts/test-local-native-site.mjs'))
  assert.equal(Object.keys(runner.hashes).length, 5)
  writeFileSync(packagePath('playwright-core'), JSON.stringify({ name: 'playwright-core', version: '1.62.1' }))
  assert.throws(() => siteRepeatRunner(options), /packages must match/)
  writeFileSync(packagePath('playwright-core'), JSON.stringify({ name: 'playwright-core', version: '1.63.0' }))
  lock.packages['node_modules/playwright-core'].version='1.62.1'
  writeFileSync(join(directory,'package-lock.json'),JSON.stringify(lock))
  assert.throws(()=>siteRepeatRunner(options),/Actual browser runner lock differs/)
  lock.packages['node_modules/playwright-core'].version='1.63.0'
  writeFileSync(join(directory,'package-lock.json'),JSON.stringify(lock))
  writeFileSync(join(directory, 'scripts/native-start-example-readiness.mjs'), '// changed')
  assert.throws(() => siteRepeatRunner(options), /Runner source differs/)
})

test('site repeats execute the identity-bound external runner without changing workflow requirements', () => {
  const entrypoint = '/private/tmp/verified-site-runner/scripts/test-local-native-site.mjs'
  const result = runSiteRepeats(siteRepeatOptions([...args, '--runs', '1']), {
    inputs: () => ({ runner: { entrypoint } }),
    run: (command, argv) => {
      assert.deepEqual(argv, [entrypoint])
      return { status: 0, stdout: log('firefox') }
    },
  })
  assert.equal(result.passed, true)
})

test('site repeats clear narrowing flags and require every full workflow milestone', () => {
  let calls = 0
  const result = runSiteRepeats(siteRepeatOptions([...args, '--runs', '2']), {
    env: { LOCAL_NATIVE_STREAM_ONLY: '1', LOCAL_NATIVE_COUNTER_ONLY: '1', LOCAL_NATIVE_STEADY_ONLY: '1', LOCAL_NATIVE_RELOAD_STRESS: '1' },
    inputs: () => ({ unchanged: true }),
    run: (command, argv, options) => {
      calls++
      for (const key of ['LOCAL_NATIVE_STREAM_ONLY', 'LOCAL_NATIVE_COUNTER_ONLY', 'LOCAL_NATIVE_STEADY_ONLY', 'LOCAL_NATIVE_RELOAD_STRESS'])
        assert.equal(options.env[key], undefined)
      assert.equal(options.env.LOCAL_NATIVE_TRACE_STREAMING, '1')
      assert.match(argv[0], /test-local-native-site\.mjs$/)
      return { status: 0, stdout: log('firefox') }
    },
  })
  assert.equal(calls, 2)
  assert.equal(result.passed, true)
})

test('site repeat stops at failure, never replaces a failing row with a later success', () => {
  let calls = 0
  const result = runSiteRepeats(siteRepeatOptions([...args, '--browser', 'all']), {
    inputs: () => ({ unchanged: true }), run: () => { calls++; return { status: 1, stdout: log('chromium') } },
  })
  assert.equal(calls, 1)
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].complete, true)
  assert.equal(result.passed, false)
})

test('site repeats fail on changed inputs, missing milestones, buffered observations and signals', () => {
  let reads = 0
  const changed = runSiteRepeats(siteRepeatOptions([...args, '--runs', '1']), {
    inputs: () => ({ revision: reads++ }), run: () => ({ status: 0, stdout: log('firefox') }),
  })
  assert.equal(changed.passed, false)
  assert.match(changed.rows[0].inputError, /inputs changed/)
  for (const child of [
    { status: 0, stdout: log('firefox').replace('firefox: Live edit passed', '') },
    { status: 0, stdout: log('firefox').replace('firefox: Basic SSR, binary asset, deferred server functions, hydration, navigation and live edit passed', '') },
    { status: 0, stdout: log('firefox').replace('firefox: Router Express SSR, hydration, post navigation and live edit passed', '') },
    { status: 0, stdout: log('firefox') + '\nfirefox: Router Express SSR, hydration, post navigation and live edit passed' },
    { status: 0, stdout: log('firefox').replace('"numbers":[1]', '"numbers":[1,10]') },
    { status: null, signal: 'SIGTERM', stdout: log('firefox') },
    { status: 0, signal: 'SIGTERM', stdout: log('firefox') },
  ]) assert.equal(runSiteRepeats(siteRepeatOptions([...args, '--runs', '1']), {
    inputs: () => ({ unchanged: true }), run: () => child,
  }).passed, false)
})
