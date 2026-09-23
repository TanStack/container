import {defineConfig} from '@playwright/test'
import base from './playwright.workloads.config'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
export default defineConfig({...base,testDir:'./tests/tls-guest',outputDir:'./test-results/tls-guest',timeout:45000,
  metadata:{...base.metadata,tlsRuntime:JSON.parse(readFileSync('public/tls-runtime/build.json','utf8')),identityBuild:JSON.parse(readFileSync('public/tls-probe/build.json','utf8')),
    testsSHA256:createHash('sha256').update(readFileSync('fixtures/guest-tls-cases.mjs')).update(readFileSync('tests/tls-guest/tls.spec.ts')).digest('hex')},
  reporter:[['list'],['json',{outputFile:'reports/tls-guest-browser-results.json'}]],
})
