import assert from 'node:assert/strict'
import test from 'node:test'
import { componentControlPlan } from '../scripts/serve-native-reload-components.mjs'
import { componentProbePlan, validateComponentProbeMode } from '../scripts/probe-native-reload-components.mjs'

const paths = ['/private/tmp/tanstack-native-site-abc123', '/installed/sdk', '/installed/hosted']

test('component host accepts only an explicit fixture and three separate loopback ports', () => {
  assert.deepEqual(componentControlPlan(paths, {}), { fixture: paths[0], sdk: paths[1], deployment: paths[2],
    owner: 'http://127.0.0.1:4357', site: 'http://127.0.0.1:4358', preview: 'http://127.0.0.1:4359', inspect: false, mode: 'components' })
  assert.equal(componentControlPlan(paths, { NATIVE_SITE_PORT: '4458' }).site, 'http://127.0.0.1:4458')
  for (const args of [[], paths.slice(0, 2), [...paths, 'extra'], ['/main-site', ...paths.slice(1)]])
    assert.throws(() => componentControlPlan(args, {}))
  for (const port of ['0', '1023', '65536', '-1', '1.5', 'NaN', '', '4357'])
    assert.throws(() => componentControlPlan(paths, { NATIVE_SITE_PORT: port }))
})

test('site-style preview inspection is an explicit diagnostic selection', () => {
  assert.equal(componentControlPlan(paths, { NATIVE_COMPONENT_INSPECT: '1' }).inspect, true)
  assert.equal(componentControlPlan(paths, { NATIVE_COMPONENT_INSPECT: '0' }).inspect, false)
  for (const value of ['', 'true', '2']) assert.throws(() => componentControlPlan(paths, { NATIVE_COMPONENT_INSPECT: value }))
})

test('workbench mode keeps the original wrapper and its own polling behavior', () => {
  const plan = componentControlPlan(paths, { NATIVE_COMPONENT_HOST: 'workbench' })
  assert.equal(plan.mode, 'workbench'); assert.equal(plan.inspect, true)
  for (const value of ['', 'replacement', 'Workbench']) assert.throws(() => componentControlPlan(paths, { NATIVE_COMPONENT_HOST: value }))
  for (const value of ['0', '1']) assert.throws(() => componentControlPlan(paths, { NATIVE_COMPONENT_HOST: 'workbench', NATIVE_COMPONENT_INSPECT: value }))
})

test('terminal release comparison is explicit and does not replace the app or SDK', () => {
  const xtermFixture = '/private/tmp/native-xterm-release-abc123'
  const plan = componentControlPlan(paths, { NATIVE_COMPONENT_HOST: 'workbench', NATIVE_COMPONENT_XTERM_FIXTURE: xtermFixture })
  assert.equal(plan.xtermFixture, xtermFixture)
  assert.equal(plan.fixture, paths[0]); assert.equal(plan.sdk, paths[1]); assert.equal(plan.deployment, paths[2])
  assert.throws(() => componentControlPlan(paths, { NATIVE_COMPONENT_XTERM_FIXTURE: xtermFixture }))
  for (const value of ['', '/main-site', '/private/tmp/native-xterm-release-abc123/node_modules'])
    assert.throws(() => componentControlPlan(paths, { NATIVE_COMPONENT_HOST: 'workbench', NATIVE_COMPONENT_XTERM_FIXTURE: value }))
})

test('component probe has explicit bounded runs and retains all three desktop engines by default', () => {
  const receipt = '/private/tmp/native-reload-components-abc123/identity.json'
  assert.deepEqual(componentProbePlan([receipt], {}), { receipt, browsers: ['chromium', 'firefox', 'webkit'], runs: 1 })
  assert.deepEqual(componentProbePlan([receipt], { NATIVE_BROWSER: 'firefox', NATIVE_COMPONENT_RUNS: '3' }), {
    receipt, browsers: ['firefox'], runs: 3,
  })
  for (const args of [[], [receipt, 'extra'], ['/main-site/identity.json']]) assert.throws(() => componentProbePlan(args, {}))
  for (const value of ['0', '11', '-1', '1.5', 'NaN', ''])
    assert.throws(() => componentProbePlan([receipt], { NATIVE_COMPONENT_RUNS: value }))
  assert.throws(() => componentProbePlan([receipt], { NATIVE_BROWSER: 'firfox' }))
})

test('small component probe rejects the real workbench before starting a browser', () => {
  validateComponentProbeMode({})
  validateComponentProbeMode({ mode: 'components' })
  assert.throws(() => validateComponentProbeMode({ mode: 'workbench' }), /Use test-local-native-terminal/)
  assert.throws(() => validateComponentProbeMode({ mode: 'unknown' }))
})
