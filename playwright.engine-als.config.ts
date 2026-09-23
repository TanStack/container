import { defineConfig } from '@playwright/test'
import base from './playwright.feasibility.config'
export default defineConfig({ ...base,
  testMatch: 'engine-als.spec.ts',
  outputDir: './test-results/engine-als',
  reporter: [['list'], ['json', {outputFile:'reports/engine-als-browser.json'}]],
})
