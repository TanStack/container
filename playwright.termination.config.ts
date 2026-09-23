import {defineConfig} from '@playwright/test'
import base from './playwright.workloads.config'
import {readFileSync} from 'node:fs'
const cooperative=process.env.TERMINATION_COOPERATIVE==='1'
const candidate=cooperative?'quickjs-als-asyncify-o2-generator-queue-yield-profile-cooperative':'quickjs-als-o2'
const wasmCandidate=cooperative?'quickjs-als-asyncify-wasm-'+(process.env.COOPERATIVE_WASM_OPT??'o2')+'-generator-queue-yield-profile-poll4096-cooperative'+(process.env.COOPERATIVE_WASM_BATCH?'-batch'+process.env.COOPERATIVE_WASM_BATCH:'')+(process.env.COOPERATIVE_ASSIGNMENTS==='1'?'-assignments':'')+(process.env.COOPERATIVE_UNWIND==='1'?'-unwind':'')+(process.env.COOPERATIVE_HEAP_LOOPS==='1'?'-heap-loops':''):'quickjs-als-wasm-o2'
export default defineConfig({...base,testDir:'./tests/termination',outputDir:'test-results/termination',
  metadata:{...base.metadata,cooperative,terminationEngine:JSON.parse(readFileSync(`public/${candidate}/build.json`,'utf8')),terminationWasmEngine:JSON.parse(readFileSync(`public/${wasmCandidate}/build.json`,'utf8'))},
  webServer:{...base.webServer as object,command:'QJS_TEST_OPT=o2 WASM_TEST_OPT=o2 npx vite --host 127.0.0.1 --port 4199 --strictPort',url:'http://127.0.0.1:4199',reuseExistingServer:false},
})
