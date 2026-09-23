import {defineConfig} from '@playwright/test'
import base from './playwright.workloads.config'
export default defineConfig({...base,testDir:'./tests/fs-paths',outputDir:'./test-results/fs-paths',reporter:[['list'],['json',{outputFile:'reports/fs-paths-browser-results.json'}]]})
