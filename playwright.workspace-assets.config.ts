import {defineConfig} from '@playwright/test'
import {readFileSync,readdirSync} from 'node:fs'
import {createHash} from 'node:crypto'
const sourcePaths=[...readdirSync('src',{recursive:true}).filter((path):path is string=>typeof path==='string'&&/\.(ts|js)$/.test(path)).map(path=>'src/'+path),
  'tests/workspace-assets/assets.spec.ts','tests/workspace-assets/cleanup.spec.ts',
  'public/vm-web-apis/globals.js','public/kernel-runtime/builtins.json','public/quickjs-als-wasm/engine.wasm',
  ...['@rollup/browser/dist/es/rollup.browser.js','@rollup/browser/dist/es/bindings_wasm_bg.wasm','sql.js/dist/sql-wasm.js','sql.js/dist/sql-wasm.wasm'].map(path=>'fixtures/workloads/node_modules/'+path)]
const sources=Object.fromEntries(sourcePaths.sort().map(path=>[path,createHash('sha256').update(readFileSync(path)).digest('hex')]))
export default defineConfig({
  metadata:{sources},testDir:'./tests/workspace-assets',outputDir:'./test-results/workspace-assets',workers:1,timeout:180000,
  use:{baseURL:'http://127.0.0.1:4209',trace:'retain-on-failure'},
  projects:[{name:'chromium',use:{browserName:'chromium'}},{name:'firefox',use:{browserName:'firefox'}},{name:'webkit',use:{browserName:'webkit'}}],
  webServer:{command:'npx vite --host 127.0.0.1 --port 4209 --strictPort',url:'http://127.0.0.1:4209',reuseExistingServer:false},
  reporter:[['list'],['json',{outputFile:'reports/workspace-assets-browser-results.json'}]],
})
