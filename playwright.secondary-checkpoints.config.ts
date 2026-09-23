import {defineConfig} from '@playwright/test'
import base from './playwright.config'

export default defineConfig({
  ...base,
  testDir:'./tests/feasibility',
  testMatch:'next-tick-backends.spec.ts',
  workers:1,
  timeout:120000,
  reporter:'list',
  outputDir:'./test-results/secondary-checkpoints',
})
