import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'

const names=['structured-clone-values','structured-ipc-child','structured-ipc-parent','structured-worker-child','structured-worker-parent']
const files=Object.fromEntries(names.map(name=>[`/fixtures/${name}.mjs`,readFileSync(`tests/fixtures/${name}.mjs`,'utf8')]))
for(const entry of ['structured-ipc-parent','structured-worker-parent'])for(const guestWasm of [false,true])test(`${entry} structured clone parity ${guestWasm?'WASM':'default'}`,async({page},info)=>{
  const native=spawnSync(process.execPath,[`tests/fixtures/${entry}.mjs`],{encoding:'utf8',timeout:15000})
  expect(native.status,native.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const guest=await page.evaluate(async({files,entry,guestWasm})=>{
    const kernel=new window.sandboxLab.WorkerKernel(files)
    try{return await kernel.runModule(`/fixtures/${entry}.mjs`,{guestWasm,webAPIs:true,timeoutMs:15000})}finally{kernel.close()}
  },{files,entry,guestWasm})
  await info.attach('structured-clone.json',{body:JSON.stringify({native:JSON.parse(native.stdout),guest}),contentType:'application/json'})
  expect(guest.exitCode,guest.stderr).toBe(0)
  expect(JSON.parse(guest.stdout)).toEqual(JSON.parse(native.stdout))
})
