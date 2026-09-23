import assert from 'node:assert/strict'
import test from 'node:test'
import {
  comparisonSummary,
  loadContract,
  validateContract,
  validateRunReport,
} from '../integrations/tanstack-four-examples/harness.mjs'

const contract = loadContract()

test('contract binds exactly four examples and their real commands', () => {
  validateContract(contract)
  assert.deepEqual(
    contract.examples.map((item) => item.id),
    [
      'start-counter',
      'start-basic',
      'start-streaming-data-from-server-functions',
      'basic-ssr-file-based',
    ],
  )
  assert.deepEqual(
    contract.examples.find((item) => item.id === 'basic-ssr-file-based').commands.start,
    ['pnpm', 'run', 'dev'],
  )
})

function report(overrides = {}) {
  const example = contract.examples[0]
  return {
    schemaVersion: 1,
    suiteId: contract.suiteId,
    runtime: 'webcontainer',
    exampleId: example.id,
    result: 'passed',
    startedAt: '2026-09-21T00:00:00.000Z',
    finishedAt: '2026-09-21T00:01:00.000Z',
    browser: { name: 'Chromium', version: '140.0.0' },
    source: { revision: contract.source.revision, treeSHA256: example.sourceTreeSHA256 },
    commands: example.commands,
    observedCommands: example.commands,
    artifact: { package: '@webcontainer/api', version: '1.6.1' },
    integration: {
      repository: 'https://github.com/TanStack/tanstack.com.git',
      revision: 'a'.repeat(40),
      files: [{ path: 'src/runtime.ts', sha256: 'b'.repeat(64) }],
    },
    adaptations: [],
    assertions: example.assertions.map(({ id }) => ({ id, result: 'passed' })),
    diagnostics: { pageErrors: [], consoleErrors: [] },
    ...overrides,
  }
}

test('a pass requires every contracted assertion', () => {
  const candidate = report({ assertions: [{ id: 'ssr', result: 'passed' }] })
  assert.throws(() => validateRunReport(candidate, contract), /hydration/)
})

test('unsupported is evidence, not a pass, and requires a limitation', () => {
  assert.throws(
    () => validateRunReport(report({ result: 'unsupported', limitation: '' }), contract),
    /limitation/,
  )
  assert.doesNotThrow(() =>
    validateRunReport(
      report({ result: 'unsupported', limitation: 'Native addons are unavailable.' }),
      contract,
    ),
  )
})

test('summary leaves missing cells not-run', () => {
  const summary = comparisonSummary([report()], contract)
  assert.equal(summary.rows[0].webcontainer.status, 'passed')
  assert.equal(summary.rows[0].webcontainer.runs.length, 1)
  assert.equal(summary.rows[0].sdk.status, 'not-run')
  assert.equal(summary.rows[1].webcontainer.status, 'not-run')
})

test('summary retains repeated browser runs and does not hide a failure', () => {
  const failed = report({
    result: 'failed',
    error: 'preview crashed',
    browser: { name: 'Firefox', version: '142.0' },
    assertions: [],
  })
  const summary = comparisonSummary([report(), failed], contract)
  assert.equal(summary.rows[0].webcontainer.status, 'failed')
  assert.equal(summary.rows[0].webcontainer.runs.length, 2)
})

test('a pass cannot substitute a different start command', () => {
  const candidate = report({
    observedCommands: {
      install: ['pnpm', 'install'],
      start: ['vite', 'dev'],
    },
  })
  assert.throws(() => validateRunReport(candidate, contract), /observed commands/)
})

test('adaptations must bind changed files or package versions', () => {
  const candidate = report({
    adaptations: [{ id: 'hidden-patch', description: 'Changes behavior', files: [], packages: [] }],
  })
  assert.throws(() => validateRunReport(candidate, contract), /at least one file or package/)
})

test('split SDK reports bind both packages and the observed deployment', () => {
  const candidate = report({runtime: 'sdk', artifact: {
    package: '@tanstack/browser-sandbox-experimental', version: '0.0.0', packaging: 'split',
    manifestSHA256: '1'.repeat(64), tarballSHA256: '2'.repeat(64),
    runtimePackage: '@tanstack/browser-sandbox-runtime-experimental',
    runtimeManifestSHA256: '3'.repeat(64), runtimeTarballSHA256: '4'.repeat(64), deploymentManifestSHA256: '5'.repeat(64),
  }, observedAssetIdentity: {sdkManifestSHA256: '1'.repeat(64), runtimeManifestSHA256: '3'.repeat(64), deploymentManifestSHA256: '5'.repeat(64)}})
  assert.doesNotThrow(() => validateRunReport(candidate, contract))
  for (const field of ['runtimeManifestSHA256', 'runtimeTarballSHA256', 'deploymentManifestSHA256']) {
    const missing = structuredClone(candidate)
    delete missing.artifact[field]
    assert.throws(() => validateRunReport(missing, contract), new RegExp(field))
  }
  for (const field of ['sdkManifestSHA256', 'runtimeManifestSHA256', 'deploymentManifestSHA256']) {
    const mismatch = structuredClone(candidate)
    mismatch.observedAssetIdentity[field] = 'f'.repeat(64)
    assert.throws(() => validateRunReport(mismatch, contract), new RegExp(field))
  }
})
