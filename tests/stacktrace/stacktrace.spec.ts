import {test,expect} from '@playwright/test'
import {runInNewContext} from 'node:vm'
import {stacktraceCases} from '../../fixtures/stacktrace-cases.mjs'
for(const directory of ['quickjs-als','quickjs-als-wasm'])for(const fixture of stacktraceCases)test(`${directory}: ${fixture.name}`,async({page},info)=>{
  const expected=runInNewContext(fixture.code,{}, {filename:'stack-capture.js',timeout:2000})
  await page.goto('/sandbox.html')
  const actual=await page.evaluate(async({directory,source})=>{
    const path='/fixtures/stacktrace-browser.mjs'
    const {probeStacktrace}=await import(/* @vite-ignore */path)
    return probeStacktrace(directory,source)
  },{directory,source:fixture.code})
  await info.attach('stacktrace.json',{body:JSON.stringify({node:process.version,expected,actual}),contentType:'application/json'})
  expect(actual).toEqual(expected)
})
