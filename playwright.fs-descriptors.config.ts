import {defineConfig} from '@playwright/test'
import base from './playwright.workloads.config'
export default defineConfig({...base,testDir:'./tests/fs-descriptors',outputDir:'./test-results/fs-descriptors',reporter:[['list'],['json',{outputFile:'reports/fs-descriptors-browser-results.json'}]]})
