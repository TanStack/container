import {defineConfig} from '@playwright/test'
import base from './playwright.workloads.config'
export default defineConfig({...base,testDir:'./tests/node-globals',outputDir:'./test-results/node-globals',reporter:[['list'],['json',{outputFile:'reports/node-globals-browser-results.json'}]]})
