import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
const source=readFileSync('tests/fixtures/node-sqlite.mjs','utf8')
test('node:sqlite default engine rejects the missing WASM capability clearly',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async source=>{const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source});try{return await kernel.runModule('/main.mjs')}finally{kernel.close()}},source)
  expect(result.exitCode).toBe(1);expect(result.stderr).toContain('node:sqlite requires guestWasm')
})
test('node:sqlite synchronous in-memory behavior matches native Node on the WASM engine',async({page},info)=>{
  const native=spawnSync(process.execPath,['tests/fixtures/node-sqlite.mjs'],{encoding:'utf8',timeout:15000})
  expect(native.status,native.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const guest=await page.evaluate(async source=>{const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source},{maxBytes:64*1024*1024});try{return await kernel.runModule('/main.mjs',{guestWasm:true,maxBytes:64*1024*1024,timeoutMs:15000})}finally{kernel.close()}},source)
  await info.attach('node-sqlite.json',{body:JSON.stringify({native:JSON.parse(native.stdout),guest}),contentType:'application/json'})
  expect(guest.exitCode,guest.stderr).toBe(0);expect(JSON.parse(guest.stdout)).toEqual(JSON.parse(native.stdout))
})
