import {defineConfig} from '@playwright/test'
import base from './playwright.workloads.config'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
const testHash=createHash('sha256')
testHash.update(readFileSync('tests/import-surface/job-profile.spec.ts'))
testHash.update(readFileSync('tests/import-surface/buffer-volume.spec.ts'))
testHash.update(readFileSync('tests/import-surface/response-stream.spec.ts'))
testHash.update(readFileSync('tests/import-surface/pipe-volume.spec.ts'))
for(const file of ['tests/import-surface/interpreter-frames.spec.ts','fixtures/interpreter-frames.mjs'])testHash.update(file).update(readFileSync(file))
for(const file of ['tests/import-surface/surface.spec.ts','tests/import-surface/inspection.spec.ts','tests/import-surface/recursion.spec.ts','fixtures/inspection-cases.mjs'])testHash.update(file+'\0').update(readFileSync(file)).update('\0')
export default defineConfig({...base,metadata:{...base.metadata,importSurfaceTestsSHA256:testHash.digest('hex')},testDir:'./tests/import-surface',outputDir:'./test-results/import-surface',timeout:45000,reporter:[['list'],['json',{outputFile:'reports/import-surface-browser-results.json'}]]})
