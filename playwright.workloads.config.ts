import {defineConfig} from '@playwright/test'
import {readFileSync,readdirSync} from 'node:fs'
import {createHash} from 'node:crypto'
const runtimeSource=createHash('sha256')
for(const file of readdirSync('src',{recursive:true}).filter((file):file is string=>typeof file==='string'&&/\.(?:ts|js)$/.test(file)).sort())runtimeSource.update(file+'\0').update(readFileSync('src/'+file)).update('\0')
export default defineConfig({
  metadata:{runtimeSourceSHA256:runtimeSource.digest('hex'),kernelEngine:JSON.parse(readFileSync('public/quickjs-als/build.json','utf8')),
    guestWasmKernelEngine:JSON.parse(readFileSync('public/quickjs-als-wasm/build.json','utf8')),
    kernelBuiltins:JSON.parse(readFileSync('public/kernel-runtime/build.json','utf8')),
    guestWebAPIs:JSON.parse(readFileSync('public/vm-web-apis/build.json','utf8'))},
  testDir:'./tests/workloads',outputDir:'./test-results/workloads',workers:1,timeout:180000,
  use:{baseURL:'http://127.0.0.1:4199',trace:'retain-on-failure'},
  projects:[
    {name:'chromium',use:{browserName:'chromium'}},
    {name:'firefox',use:{browserName:'firefox'}},
    {name:'webkit',use:{browserName:'webkit'}},
  ],
  webServer:{command:'npx vite --host 127.0.0.1 --port 4199 --strictPort',url:'http://127.0.0.1:4199',reuseExistingServer:false},
  reporter:[['list'],['json',{outputFile:'reports/workload-browser-results.json'}]],
})
