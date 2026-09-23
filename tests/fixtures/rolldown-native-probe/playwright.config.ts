import {defineConfig} from '@playwright/test'
export default defineConfig({testDir:'.',testMatch:'native-probe.spec.ts',workers:1,retries:0,timeout:60000,outputDir:'../../../test-results/rolldown-native-probe',projects:['chromium','firefox','webkit'].map(browserName=>({name:browserName,use:{browserName:browserName as 'chromium'|'firefox'|'webkit'}}))})
