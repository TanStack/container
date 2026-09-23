import {defineConfig} from '@playwright/test'
import base from './playwright.workloads.config'
export default defineConfig({...base,testDir:'./tests/lab-cold',webServer:undefined,outputDir:'test-results/lab-cold'})
