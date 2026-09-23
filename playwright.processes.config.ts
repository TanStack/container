import {defineConfig} from '@playwright/test'
import base from './playwright.workloads.config'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
export default defineConfig({...base,metadata:{...base.metadata,processTestsSHA256:createHash('sha256').update(readFileSync('tests/processes/processes.spec.ts')).update(readFileSync('tests/processes/cwd.spec.ts')).digest('hex')},testDir:'./tests/processes',outputDir:'./test-results/processes',timeout:45000,reporter:[['list'],['json',{outputFile:'reports/process-browser-results.json'}]]})
