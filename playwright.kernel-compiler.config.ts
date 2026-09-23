import {defineConfig} from '@playwright/test'
export default defineConfig({testDir:'./tests/kernel-compiler',outputDir:'test-results/kernel-compiler',workers:1,timeout:90000,
  use:{baseURL:'http://127.0.0.1:4293',trace:'retain-on-failure'},
  projects:['chromium','firefox','webkit'].map(browserName=>({name:browserName,use:{browserName:browserName as 'chromium'|'firefox'|'webkit'}})),
  webServer:{command:'npx vite --host 127.0.0.1 --port 4293 --strictPort',url:'http://127.0.0.1:4293',reuseExistingServer:false},
})
