import {defineConfig} from '@playwright/test'
import base from './playwright.feasibility.config'

// Engine coverage on this host, not Safari/Edge or another operating system.
// The installed Chrome channel adds one real shipping-browser check.
export default defineConfig({...base,
  testDir:'./tests/desktop',
  workers:1,
  projects:[...base.projects!,{name:'chrome',use:{browserName:'chromium',channel:'chrome'}}],
  outputDir:'./test-results/desktop',
  reporter:[['list'],['json',{outputFile:process.env.SANDBOX_DESKTOP_BACKEND==='kernel'?'reports/kernel-desktop-results.json':'reports/desktop-results.json'}]],
})
