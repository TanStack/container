import {defineConfig} from '@playwright/test'
import {readFileSync,readdirSync} from 'node:fs'
import {createHash} from 'node:crypto'
// @ts-expect-error Shared JavaScript evidence collector.
import {guestWasmInputHashes} from './scripts/guest-wasm-evidence.mjs'
const sources=Object.fromEntries([
  ...readdirSync('src',{recursive:true}).filter((path):path is string=>typeof path==='string'&&/\.(ts|js|c)$/.test(path)).map(path=>'src/'+path),
  ...readdirSync('tests/guest-wasm').filter(path=>path.endsWith('.ts')).map(path=>'tests/guest-wasm/'+path),
  'public/kernel-runtime/builtins.json','public/vm-web-apis/globals.js',
].sort().map(path=>[path,createHash('sha256').update(readFileSync(path)).digest('hex')]))
export default defineConfig({
  metadata:{engine:JSON.parse(readFileSync('public/quickjs-als-wasm/build.json','utf8')),inputs:guestWasmInputHashes(),sources},
  testDir:'./tests/guest-wasm',outputDir:'./test-results/guest-wasm',workers:1,timeout:180000,
  use:{baseURL:'http://127.0.0.1:4208',trace:'retain-on-failure'},
  projects:[{name:'chromium',use:{browserName:'chromium'}},{name:'firefox',use:{browserName:'firefox'}},{name:'webkit',use:{browserName:'webkit'}}],
  webServer:{command:'npx vite --host 127.0.0.1 --port 4208 --strictPort',url:'http://127.0.0.1:4208',reuseExistingServer:false},
  reporter:[['list'],['json',{outputFile:'reports/guest-wasm-browser-results.json'}]],
})
