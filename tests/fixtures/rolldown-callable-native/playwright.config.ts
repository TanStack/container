import {defineConfig} from '@playwright/test'
export default defineConfig({testDir:'.',testMatch:'callable.spec.ts',workers:1,retries:0,timeout:90000,outputDir:'../../../test-results/rolldown-callable-native',projects:['chromium','firefox','webkit'].map(browserName=>({name:browserName,use:{browserName:browserName as 'chromium'|'firefox'|'webkit'}}))})
