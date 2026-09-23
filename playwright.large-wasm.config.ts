import {defineConfig} from '@playwright/test'
import base from './playwright.workloads.config'
export default defineConfig({...base,testDir:'./tests/large-wasm',outputDir:'./test-results/large-wasm',reporter:[['list'],['json',{outputFile:'reports/large-wasm-browser-results.json'}]]})
