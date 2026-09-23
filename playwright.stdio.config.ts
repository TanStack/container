import {defineConfig} from '@playwright/test'
import base from './playwright.workloads.config'
export default defineConfig({...base,testDir:'./tests/stdio',outputDir:'./test-results/stdio',reporter:[['list'],['json',{outputFile:'reports/stdio-browser-results.json'}]]})
