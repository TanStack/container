import { defineConfig } from '@playwright/test'
import base from './playwright.workloads.config'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const files = ['scripts/http2-peer.mjs', 'fixtures/http2-workflow.mjs', 'tests/http2/protocol.spec.ts']
export default defineConfig({
  ...base, testDir: './tests/http2', testMatch: '**/protocol.spec.ts', outputDir: './test-results/http2', timeout: 60000,
  metadata: {
    build: JSON.parse(readFileSync('public/http2-probe/build.json', 'utf8')),
    hashes: Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')])),
  },
  reporter: [['list'], ['json', { outputFile: 'reports/http2-browser-results.json' }]],
})
