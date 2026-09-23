import {defineConfig} from '@playwright/test'
import {readFileSync} from 'node:fs'
export default defineConfig({
  metadata: {build: JSON.parse(readFileSync('public/wasm-interpreter-probe/build.json', 'utf8')),
    ubsan: JSON.parse(readFileSync('public/wasm-interpreter-probe-ubsan/build.json', 'utf8'))},
  testDir: './tests/wasm-interpreter', outputDir: './test-results/wasm-interpreter', workers: 1, timeout: 60000,
  use: {baseURL: 'http://127.0.0.1:4207', trace: 'retain-on-failure'},
  projects: ['chromium', 'firefox', 'webkit'].map(name => ({name, use: {browserName: name as 'chromium' | 'firefox' | 'webkit'}})),
  webServer: {command: 'npx vite --host 127.0.0.1 --port 4207 --strictPort', url: 'http://127.0.0.1:4207', reuseExistingServer: false},
  reporter: [['list'], ['json', {outputFile: 'reports/wasm-interpreter-browser-results.json'}]],
})
