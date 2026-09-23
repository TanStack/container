import {defineConfig} from '@playwright/test'
import base from './playwright.fiber-kernel.config'

export default defineConfig({
  ...base,
  testDir:'./tests/fiber-compiler-bindings',
  outputDir:'./test-results/fiber-compiler-bindings',
  timeout:60000,
  reporter:[['list'],['json',{outputFile:'reports/fiber-compiler-bindings.json'}]],
})
