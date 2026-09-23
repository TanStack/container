import {defineConfig} from '@playwright/test'
import base from './playwright.guest-wasm.config'
export default defineConfig({...base,testMatch:'guest.spec.ts',grep:/validator grows|guest WASM deadlines|guest callbacks retain ALS|callback deadlines/,outputDir:'./test-results/validator-control',reporter:[['list'],['json',{outputFile:'reports/validator-control-browser-results.json'}]]})
