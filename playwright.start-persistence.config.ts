import {defineConfig} from '@playwright/test'
export default defineConfig({
  testDir:'./tests/sdk-frameworks',testMatch:'start-workspace-persistence.spec.ts',
  workers:1,retries:0,timeout:30000,
  projects:['chromium','firefox','webkit'].map(browserName=>({name:browserName,use:{browserName:browserName as 'chromium'|'firefox'|'webkit'}})),
})
