import {defineConfig} from '@playwright/test'
import base from './playwright.feasibility.config'
export default defineConfig({...base,testMatch:'combined-engine.spec.ts',
  outputDir:'./test-results/combined-engine',
  reporter:[['list'],['json',{outputFile:'reports/combined-engine.json'}]],
})
