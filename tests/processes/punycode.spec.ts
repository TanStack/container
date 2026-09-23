import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
const source=readFileSync('tests/fixtures/node-punycode.mjs','utf8')
for(const guestWasm of [false,true])test(`node:punycode native parity ${guestWasm?'WASM':'default'}`,async({page})=>{
  const native=spawnSync(process.execPath,['tests/fixtures/node-punycode.mjs'],{encoding:'utf8',timeout:15000})
  expect(native.status,native.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const guest=await page.evaluate(async({source,guestWasm})=>{const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source});try{return await kernel.runModule('/main.mjs',{guestWasm})}finally{kernel.close()}},{source,guestWasm})
  expect(guest.exitCode,guest.stderr).toBe(0);expect(JSON.parse(guest.stdout)).toEqual(JSON.parse(native.stdout))
})
