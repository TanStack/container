import {defineConfig} from '@playwright/test'
import base from './playwright.workloads.config'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
export default defineConfig({...base,testDir:'./tests/tls-probe',outputDir:'./test-results/tls-probe',timeout:120000,
  metadata:{tlsProbe:JSON.parse(readFileSync('public/tls-probe/build.json','utf8')),testSHA256:createHash('sha256').update(readFileSync('tests/tls-probe/tls.spec.ts')).digest('hex')},
  reporter:[['list'],['json',{outputFile:'reports/tls-probe-browser-results.json'}]],
})
