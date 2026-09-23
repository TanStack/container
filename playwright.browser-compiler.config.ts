import {defineConfig} from '@playwright/test'
export default defineConfig({testDir:'./tests/browser-compiler',workers:1,timeout:60000,outputDir:'test-results/browser-compiler',projects:['chromium','firefox','webkit'].map(browserName=>({name:browserName,use:{browserName:browserName as 'chromium'|'firefox'|'webkit'}}))})
