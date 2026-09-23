import {defineConfig} from '@playwright/test'
export default defineConfig({testDir:'./tests/start-native',outputDir:'./test-results/start-native',workers:1,timeout:120000,
  use:{trace:'retain-on-failure'},projects:['chromium','firefox','webkit'].map(name=>({name,use:{browserName:name as 'chromium'|'firefox'|'webkit'}}))})
