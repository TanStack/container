import {defineConfig} from '@playwright/test'
export default defineConfig({testDir:'./tests/sdk-shell',workers:1,timeout:60000,
  projects:['chromium','firefox','webkit'].map(browserName=>({name:browserName,use:{browserName:browserName as 'chromium'|'firefox'|'webkit'}})),
})
