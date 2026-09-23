import {defineConfig} from '@playwright/test'
import base from './playwright.processes.config'
import {readFileSync} from 'node:fs'
export default defineConfig({...base,
  metadata:{...base.metadata,
    candidateEngine:JSON.parse(readFileSync('public/quickjs-als-o2/build.json','utf8')),
    candidateWasmEngine:JSON.parse(readFileSync('public/quickjs-als-wasm-o2/build.json','utf8')),
  },
  webServer:{...base.webServer as object,command:'QJS_TEST_OPT=o2 WASM_TEST_OPT=o2 npx vite --host 127.0.0.1 --port 4199 --strictPort',url:'http://127.0.0.1:4199',reuseExistingServer:false},
})
