import {defineConfig} from '@playwright/test'
export default defineConfig({testDir:'./tests/generator-resume',workers:1,timeout:30000,
  projects:['chromium','firefox','webkit'].map(browserName=>({name:browserName,use:{browserName:browserName as 'chromium'|'firefox'|'webkit'}})),
})
