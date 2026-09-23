import {defineConfig} from '@playwright/test'
import base from './playwright.workloads.config'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
const files=['src/sandbox/tls-backend.ts','fixtures/tls-owned-workflow.mjs','tests/tls-owned/owned.spec.ts']
const hashes=Object.fromEntries(files.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]))
export default defineConfig({...base,testDir:'./tests/tls-owned',outputDir:'./test-results/tls-owned',timeout:90000,
  metadata:{tlsRuntime:JSON.parse(readFileSync('public/tls-runtime/build.json','utf8')),identityBuild:JSON.parse(readFileSync('public/tls-probe/build.json','utf8')),hashes},
  reporter:[['list'],['json',{outputFile:'reports/tls-owned-browser-results.json'}]],
})
