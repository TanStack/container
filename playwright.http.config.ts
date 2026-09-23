import {defineConfig} from '@playwright/test'
import base from './playwright.workloads.config'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
export default defineConfig({...base,metadata:{...base.metadata,httpTestsSHA256:createHash('sha256').update(readFileSync('tests/http/http.spec.ts')).digest('hex')},testDir:'./tests/http',outputDir:'./test-results/http',timeout:45000,reporter:[['list'],['json',{outputFile:'reports/http-browser-results.json'}]]})
