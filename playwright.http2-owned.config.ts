import { defineConfig } from '@playwright/test'
import base from './playwright.workloads.config'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
process.env.HTTP2_OWNED = '1'
const files = ['src/sandbox/http2-backend.ts', 'scripts/http2-owned-peer.mjs', 'scripts/http2-peer.mjs', 'fixtures/http2-workflow.mjs', 'fixtures/http2-owned-workflow.mjs', 'tests/http2/protocol.spec.ts', 'tests/http2/ownership.spec.ts']
export default defineConfig({
  ...base, testDir: './tests/http2', outputDir: './test-results/http2-owned', timeout: 60000,
  metadata: {
    build: JSON.parse(readFileSync('public/http2-runtime/build.json', 'utf8')),
    hashes: Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')])),
  },
  reporter: [['list'], ['json', { outputFile: 'reports/http2-owned-browser-results.json' }]],
})
