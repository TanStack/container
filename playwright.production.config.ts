import { defineConfig } from '@playwright/test'
import base from './playwright.config'

export default defineConfig({
  ...base,
  outputDir: './test-results/production',
  grep: /agent tool loop|QuickJS probe|Vite projects|real Start SSR|URL preview|QuickJS workspace|worker kernel runtime modules/,
  reporter: [
    ['list'],
    ['json', { outputFile: 'reports/production-results.json' }],
  ],
  use: { baseURL: 'http://127.0.0.1:4183' },
  webServer: [
    {
      command: 'npx vite preview --host 127.0.0.1 --port 4183 --strictPort',
      url: 'http://127.0.0.1:4183',
      reuseExistingServer: false,
    },
    {
      command: 'node scripts/serve-preview-host.mjs',
      url: 'http://127.0.0.1:4174/__sandbox/health',
      reuseExistingServer: true,
    },
  ],
})
