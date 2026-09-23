import {defineConfig} from '@playwright/test'
import base from './playwright.workloads.config'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
export default defineConfig({...base,metadata:{...base.metadata,readlineTestsSHA256:createHash('sha256').update(readFileSync('tests/readline/readline.spec.ts')).digest('hex')},testDir:'./tests/readline',outputDir:'./test-results/readline',reporter:[['list'],['json',{outputFile:'reports/readline-browser-results.json'}]]})
