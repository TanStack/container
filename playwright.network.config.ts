import {defineConfig} from '@playwright/test'
import base from './playwright.workloads.config'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
export default defineConfig({...base,metadata:{...base.metadata,networkTestsSHA256:createHash('sha256').update(readFileSync('tests/network/network.spec.ts')).digest('hex')},testDir:'./tests/network',outputDir:'./test-results/network',timeout:30000,reporter:[['list'],['json',{outputFile:'reports/network-browser-results.json'}]]})
