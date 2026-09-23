import {defineConfig} from '@playwright/test'
import base from './playwright.workloads.config'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
const inputs=createHash('sha256')
for(const file of ['fixtures/stacktrace-cases.mjs','fixtures/stacktrace-browser.mjs','tests/stacktrace/stacktrace.spec.ts'])inputs.update(file+'\0').update(readFileSync(file)).update('\0')
export default defineConfig({...base,metadata:{...base.metadata,stacktraceTestsSHA256:inputs.digest('hex')},testDir:'./tests/stacktrace',outputDir:'./test-results/stacktrace',timeout:30000,reporter:[['list'],['json',{outputFile:'reports/stacktrace-browser-results.json'}]]})
