import {test,expect} from '@playwright/test'
for(const directory of ['quickjs-als','quickjs-als-wasm'])test(`${directory}: Function and bind survive allocation pressure`,async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async directory=>{
    const path='/fixtures/compiler-allocation-browser.mjs'
    const {probeCompilerAllocation}=await import(/* @vite-ignore */path)
    return probeCompilerAllocation(directory)
  },directory)
  await info.attach('allocation-sweep.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.attempts).toBe(257)
  expect(result.failures).toBeGreaterThan(0)
  expect(result.successes).toBeGreaterThan(0)
  expect(result.recoveries).toBe(257)
})
