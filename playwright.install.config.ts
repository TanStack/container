import {defineConfig} from '@playwright/test'
import base from './playwright.workloads.config'
import {readFileSync,readdirSync} from 'node:fs'
import {createHash} from 'node:crypto'
const inputs=createHash('sha256')
for(const directory of ['tests/install','fixtures/install-react','fixtures/install-start','fixtures/install-express']){
  for(const file of readdirSync(directory).sort())inputs.update(directory+'/'+file+'\0').update(readFileSync(directory+'/'+file)).update('\0')
}
inputs.update(readFileSync('tests/fixtures/npm-project.ts'))
export default defineConfig({...base,metadata:{...base.metadata,installationInputsSHA256:inputs.digest('hex')},testDir:'./tests/install',outputDir:'./test-results/install',reporter:[['list'],['json',{outputFile:'reports/project-install-browser-results.json'}]]})
