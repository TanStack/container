import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results/development',
  workers: 3,
  timeout: 30_000,
  reporter: [
    ['list'],
    ['json', { outputFile: 'reports/browser-results.json' }],
  ],
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
  ],
  use: {
    baseURL: 'http://127.0.0.1:4173',
  },
  webServer: [
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 4173',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: true,
    },
    {
      command: 'node scripts/serve-preview-host.mjs',
      url: 'http://127.0.0.1:4174/__sandbox/health',
      reuseExistingServer: true,
    },
  ],
})
