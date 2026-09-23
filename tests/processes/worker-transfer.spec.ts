import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
const source=readFileSync('tests/fixtures/worker-transfer-parent.mjs','utf8')
for(const guestWasm of [false,true])test(`ArrayBuffer worker transfer ownership ${guestWasm?'WASM':'default'}`,async({page})=>{
 const native=spawnSync(process.execPath,['tests/fixtures/worker-transfer-parent.mjs'],{encoding:'utf8',timeout:15000})
 expect(native.status,native.stderr).toBe(0)
 await page.goto('/sandbox.html')
 const result=await page.evaluate(async({source,guestWasm})=>{
  const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source})
  try{return await kernel.runModule('/main.mjs',{guestWasm,webAPIs:true,timeoutMs:15000})}finally{kernel.close()}
 },{source,guestWasm})
 expect(result.exitCode,result.stderr).toBe(0)
 expect(JSON.parse(result.stdout)).toEqual(JSON.parse(native.stdout))
})
