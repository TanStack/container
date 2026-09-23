import {defineConfig} from '@playwright/test'
import base from './playwright.workloads.config'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
export default defineConfig({...base,metadata:{...base.metadata,sessionTestsSHA256:createHash('sha256').update(readFileSync('tests/sessions/sessions.spec.ts')).digest('hex')},testDir:'./tests/sessions',outputDir:'./test-results/sessions',timeout:45000,reporter:[['list'],['json',{outputFile:'reports/session-browser-results.json'}]]})
