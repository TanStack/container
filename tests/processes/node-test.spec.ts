import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'

const fixtures=['pass','only','fail']
const statuses=(text:string)=>Object.fromEntries([...text.matchAll(/^\s*(?:ok|not ok) \d+ - (sync test|async test|skipped test|todo test|not selected|selected test|failing assertion|passing neighbor)(?: # (SKIP|TODO))?/gm)].map(match=>[match[1],{pass:!match[0].trimStart().startsWith('not ok'),directive:match[2]??''}]))
for(const fixture of fixtures)for(const guestWasm of [false,true])test(`node:test ${fixture} ${guestWasm?'WASM':'default'}`,async({page},info)=>{
  const path=`tests/fixtures/node-test-${fixture}.mjs`,source=readFileSync(path,'utf8')
  const native=spawnSync(process.execPath,['--test',...(fixture==='only'?['--test-only']:[]),'--test-reporter=tap',path],{encoding:'utf8',timeout:15000})
  await page.goto('/sandbox.html')
  const guest=await page.evaluate(async({source,guestWasm})=>{const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source});try{return await kernel.runModule('/main.mjs',{guestWasm,timeoutMs:15000})}finally{kernel.close()}},{source,guestWasm})
  await info.attach('node-test.json',{body:JSON.stringify({native:{status:native.status,stdout:native.stdout,stderr:native.stderr},guest}),contentType:'application/json'})
  expect(guest.exitCode).toBe(native.status)
  expect(statuses(guest.stdout)).toEqual(statuses(native.stdout))
  if(fixture==='fail'){expect(guest.stdout).toContain('ERR_ASSERTION');expect(guest.exitCode).toBe(1)}
})
