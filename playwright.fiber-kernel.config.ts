import {defineConfig} from '@playwright/test'
import {readFileSync} from 'node:fs'
import base from './playwright.workloads.config'
export default defineConfig({...base,metadata:{...base.metadata,
  fiberEngine:JSON.parse(readFileSync('public/quickjs-als-asyncify-atomics-fibers-shared-storage/build.json','utf8')),
  fiberWasmEngine:JSON.parse(readFileSync('public/quickjs-als-asyncify-wasm-atomics-fibers-shared-storage/build.json','utf8')),
},testDir:'./tests/fiber-kernel',outputDir:'./test-results/fiber-kernel',timeout:45000,reporter:[['list'],['json',{outputFile:'reports/fiber-kernel.json'}]]})
