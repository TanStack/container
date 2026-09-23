import { defineConfig } from '@playwright/test'
import base from './playwright.config'
export default defineConfig({
  ...base,
  testDir: './tests/feasibility',
  outputDir: './test-results/feasibility',
  timeout: 180_000,
  workers: 3,
  use: { baseURL: 'http://127.0.0.1:4186' },
  webServer: [
    {
      command: 'npx vite preview --host 127.0.0.1 --port 4186 --strictPort',
      url: 'http://127.0.0.1:4186',
      reuseExistingServer: false,
    },
    {
      command: 'node scripts/serve-preview-host.mjs',
      url: 'http://127.0.0.1:4174/__sandbox/health',
      reuseExistingServer: true,
    },
  ],
  reporter: [
    ['list'],
    ['json', { outputFile: 'reports/feasibility-results.json' }],
  ],
})
