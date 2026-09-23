import { defineConfig } from '@playwright/test'
import base from './playwright.workloads.config'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const files = ['src/sandbox/http2-backend.ts', 'src/sandbox/guest-http2.js', 'fixtures/guest-http2-bridge.mjs', 'tests/http2-guest/bridge.spec.ts', 'fixtures/guest-http2-cases.mjs', 'tests/http2-guest/api.spec.ts']
export default defineConfig({
  ...base, testDir: './tests/http2-guest', outputDir: './test-results/http2-guest', timeout: 60000,
  metadata: { ...base.metadata, http2: JSON.parse(readFileSync('public/http2-runtime/build.json', 'utf8')),
    hashes: Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')])) },
  reporter: [['list'], ['json', { outputFile: 'reports/http2-guest-browser-results.json' }]],
})
