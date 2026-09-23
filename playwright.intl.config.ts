import {defineConfig} from '@playwright/test'
import base from './playwright.workloads.config'
export default defineConfig({...base,testDir:'./tests/intl',outputDir:'./test-results/intl',reporter:[['list'],['json',{outputFile:'reports/intl-browser-results.json'}]]})
