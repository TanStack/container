import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
const source=readFileSync('tests/fixtures/worker-eval-parent.mjs','utf8')
for(const guestWasm of [false,true])test(`eval worker explicit CommonJS and ESM ${guestWasm?'WASM':'default'}`,async({page},info)=>{
 const native=spawnSync(process.execPath,['tests/fixtures/worker-eval-parent.mjs'],{encoding:'utf8',timeout:15000})
 expect(native.status,native.stderr).toBe(0)
 const expected=JSON.parse(native.stdout)
 await page.goto('/sandbox.html')
 const result=await page.evaluate(async({source,guestWasm})=>{
  const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source})
  try{return await kernel.runModule('/main.mjs',{guestWasm,webAPIs:true,timeoutMs:15000})}finally{kernel.close()}
 },{source,guestWasm})
 await info.attach('worker-eval.json',{body:JSON.stringify({expected,result}),contentType:'application/json'})
 expect(result.exitCode,result.stderr).toBe(0)
 expect(JSON.parse(result.stdout)).toEqual(expected)
})
test('eval workers reject unspecified mode instead of guessing Node syntax detection',async({page})=>{
 await page.goto('/sandbox.html')
 const result=await page.evaluate(async()=>{
  const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':`import {Worker} from 'node:worker_threads';
   const errors=[];
   for(const options of [{eval:true},{eval:true,execArgv:['--inspect']}]){
    try{new Worker('42',options);throw Error('Expected rejection')}catch(error){errors.push(error.code)}
   }
   console.log(JSON.stringify(errors));`})
  try{return await kernel.runModule('/main.mjs',{webAPIs:true,timeoutMs:15000})}finally{kernel.close()}
 })
 expect(result.exitCode,result.stderr).toBe(0)
 expect(JSON.parse(result.stdout)).toEqual(['ERR_UNSUPPORTED_OPERATION','ERR_UNSUPPORTED_OPERATION'])
})
