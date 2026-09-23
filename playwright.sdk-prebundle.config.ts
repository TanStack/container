import {defineConfig} from '@playwright/test'
import base from './playwright.sdk-frameworks.config'

export default defineConfig({
  ...base,
  testMatch:['prebundle-consumer.spec.ts'],
})
