import {defineConfig} from '@playwright/test'
import base from './playwright.workloads.config'

const testMatch=[
  'processes/worker-output.spec.ts',
  'processes/worker-data-url.spec.ts',
  'processes/worker-transfer.spec.ts',
  'processes/worker-port.spec.ts',
  'processes/nested-workers.spec.ts',
  'processes/module-hooks.spec.ts',
  'processes/fs-watch-extra.spec.ts',
  'processes/managed-shell.spec.ts',
  'processes/package-bin.spec.ts',
  'processes/terminal.spec.ts',
  'processes/http-agent.spec.ts',
  'processes/processes.spec.ts',
  'processes/structured-clone.spec.ts',
  'processes/node-test.spec.ts',
  'processes/node-sqlite.spec.ts',
  'processes/punycode.spec.ts',
  'processes/node-domain.spec.ts',
  'install/lifecycle.spec.ts',
  'install/peer-semver.spec.ts',
  'install/workspace-graph.spec.ts',
  'install/lockless-direct.spec.ts',
  'install/package-cache.spec.ts',
  'node-globals/process-report.spec.ts',
  'import-surface/surface.spec.ts',
  'desktop/long-session.spec.ts',
  'dgram/dgram.spec.ts',
  'cluster/cluster.spec.ts',
  'readline/keypress.spec.ts',
]

export default defineConfig({
  ...base,
  testDir:'./tests',
  testMatch,
  outputDir:'./test-results/pending-compat',
  timeout:60_000,
  workers:1,
  reporter:[['list'],['json',{outputFile:'reports/pending-compat-browser-results.json'}]],
})
