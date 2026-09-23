import {defineConfig} from '@playwright/test'

export default defineConfig({
  testDir:'./tests/sdk-frameworks',
  testMatch:'site-start-counter.spec.ts',
  workers:1,
  retries:0,
  timeout:240000,
  outputDir:'test-results/sdk-site-counter',
  projects:['chromium','firefox','webkit'].map(browserName=>({name:browserName,use:{browserName:browserName as 'chromium'|'firefox'|'webkit'}})),
})
