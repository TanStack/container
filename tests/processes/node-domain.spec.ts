import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
const source=readFileSync('tests/fixtures/node-domain.mjs','utf8')
for(const guestWasm of [false,true])test(`node:domain bounded compatibility ${guestWasm?'WASM':'default'}`,async({page},info)=>{
  const native=spawnSync(process.execPath,['tests/fixtures/node-domain.mjs'],{encoding:'utf8',timeout:15000})
  expect(native.status,native.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const guest=await page.evaluate(async({source,guestWasm})=>{const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source});try{return await kernel.runModule('/main.mjs',{guestWasm,timeoutMs:15000})}finally{kernel.close()}},{source,guestWasm})
  await info.attach('node-domain.json',{body:JSON.stringify({native:JSON.parse(native.stdout),guest}),contentType:'application/json'})
  expect(guest.exitCode,guest.stderr).toBe(0);expect(JSON.parse(guest.stdout)).toEqual(JSON.parse(native.stdout))
})
