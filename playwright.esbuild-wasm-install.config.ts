import {defineConfig} from '@playwright/test'
import base from './playwright.workloads.config'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
const inputs=createHash('sha256')
inputs.update(readFileSync('fixtures/esbuild-mixed-service.mjs'))
for(const file of ['tests/esbuild-wasm-install/transform.spec.ts','fixtures/start-compiler-transforms.json','fixtures/install-esbuild-wasm/package.json','fixtures/install-esbuild-wasm/package-lock.json'])inputs.update(file).update(readFileSync(file))
export default defineConfig({...base,metadata:{...base.metadata,esbuildInstallationSHA256:inputs.digest('hex')},testDir:'./tests/esbuild-wasm-install',outputDir:'./test-results/esbuild-wasm-install',reporter:[['list'],['json',{outputFile:'reports/esbuild-wasm-install-browser-results.json'}]]})
