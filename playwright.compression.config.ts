import {defineConfig} from '@playwright/test'
import base from './playwright.workloads.config'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
export default defineConfig({...base,metadata:{...base.metadata,compressionTestsSHA256:createHash('sha256').update(readFileSync('tests/compression/compression.spec.ts')).update(readFileSync('tests/compression/startup-snapshot.spec.ts')).digest('hex')},testDir:'./tests/compression',outputDir:'./test-results/compression',timeout:60000,reporter:[['list'],['json',{outputFile:'reports/compression-browser-results.json'}]]})
