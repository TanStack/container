import {defineConfig} from '@playwright/test'
import base from './playwright.processes.config'
export default defineConfig({...base,testMatch:'vm-modules.spec.ts',outputDir:'test-results/vm-modules',
  webServer:{...base.webServer as object,command:'QJS_TEST_OPT=o2-vm-modules WASM_TEST_OPT=o2-vm-modules npx vite --host 127.0.0.1 --port 4199 --strictPort',url:'http://127.0.0.1:4199',reuseExistingServer:false},
})
