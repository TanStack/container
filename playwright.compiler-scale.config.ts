import {defineConfig} from '@playwright/test'
import {readFileSync,readdirSync} from 'node:fs'
import {createHash} from 'node:crypto'
const paths=[...readdirSync('src',{recursive:true}).filter((path):path is string=>typeof path==='string'&&/\.(ts|js|c)$/.test(path)).map(path=>'src/'+path),
  'fixtures/compiler-scale.mjs','tests/compiler-scale/rollup.spec.ts','playwright.compiler-scale.config.ts',
  'public/quickjs-als-wasm/engine.wasm','public/quickjs-als-wasm/engine.mjs','public/kernel-runtime/builtins.json','public/vm-web-apis/globals.js',
  'fixtures/workloads/node_modules/@rollup/browser/dist/es/rollup.browser.js','fixtures/workloads/node_modules/@rollup/browser/dist/es/bindings_wasm_bg.wasm']
const sources=Object.fromEntries(paths.sort().map(path=>[path,createHash('sha256').update(readFileSync(path)).digest('hex')]))
export default defineConfig({
  metadata:{sources},testDir:'./tests/compiler-scale',outputDir:'./test-results/compiler-scale',workers:1,timeout:180000,
  use:{baseURL:'http://127.0.0.1:4210',trace:'retain-on-failure'},
  projects:[{name:'chromium',use:{browserName:'chromium'}},{name:'firefox',use:{browserName:'firefox'}},{name:'webkit',use:{browserName:'webkit'}}],
  webServer:{command:'npx vite --host 127.0.0.1 --port 4210 --strictPort',url:'http://127.0.0.1:4210',reuseExistingServer:false},
  reporter:[['list'],['json',{outputFile:'reports/compiler-scale-browser-results.json'}]],
})
