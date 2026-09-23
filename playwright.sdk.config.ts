import {defineConfig} from '@playwright/test'
export default defineConfig({testDir:'./tests/sdk',workers:1,timeout:120000,
  projects:['chromium','firefox','webkit'].map(browserName=>({name:browserName,use:{browserName:browserName as 'chromium'|'firefox'|'webkit'}})),
})
