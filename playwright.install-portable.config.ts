import {defineConfig} from '@playwright/test'
import base from './playwright.workloads.config'
import {readFileSync,readdirSync} from 'node:fs'
import {createHash} from 'node:crypto'
const inputs=createHash('sha256')
for(const directory of ['tests/install-portable','fixtures/install-start-portable'])for(const file of readdirSync(directory).sort())inputs.update(directory+'/'+file+'\0').update(readFileSync(directory+'/'+file))
export default defineConfig({...base,metadata:{...base.metadata,portableInstallationSHA256:inputs.digest('hex')},testDir:'./tests/install-portable',outputDir:'./test-results/install-portable',reporter:[['list'],['json',{outputFile:'reports/portable-install-browser-results.json'}]]})
