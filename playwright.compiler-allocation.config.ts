import {defineConfig} from '@playwright/test'
import base from './playwright.workloads.config'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
const inputs=createHash('sha256')
for(const file of ['fixtures/compiler-allocation-browser.mjs','tests/compiler-allocation/allocation.spec.ts'])inputs.update(file+'\0').update(readFileSync(file)).update('\0')
export default defineConfig({...base,metadata:{...base.metadata,allocationTestsSHA256:inputs.digest('hex')},testDir:'./tests/compiler-allocation',outputDir:'./test-results/compiler-allocation',timeout:90000,reporter:[['list'],['json',{outputFile:'reports/compiler-allocation-browser-results.json'}]]})
