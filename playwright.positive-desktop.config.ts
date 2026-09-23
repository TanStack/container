import {defineConfig} from '@playwright/test'
import {readFileSync} from 'node:fs'
import base from './playwright.workloads.config'

const suite=JSON.parse(readFileSync('compat/positive-desktop-suite.json','utf8')) as {specs:string[]}

export default defineConfig({
  ...base,
  testDir:'./tests',
  testMatch:suite.specs,
  outputDir:'./test-results/positive-desktop',
  timeout:180_000,
  workers:1,
  fullyParallel:false,
  retries:0,
  forbidOnly:true,
  reporter:[['list'],['json',{outputFile:'reports/positive-desktop-browser-results.json'}]],
})
