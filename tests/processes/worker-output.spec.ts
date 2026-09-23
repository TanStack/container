import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'

const files=Object.fromEntries(['worker-output-parent.mjs','worker-output-child.mjs'].map(name=>['/'+name,readFileSync('tests/fixtures/'+name,'utf8')]))
for(const guestWasm of [false,true])test(`worker captured stdout and stderr ${guestWasm?'WASM':'default'}`,async({page})=>{
  const native=spawnSync(process.execPath,['tests/fixtures/worker-output-parent.mjs'],{encoding:'utf8',timeout:15000})
  expect(native.status,native.stderr).toBe(0)
  expect(JSON.parse(native.stdout)).toEqual({stdout:[0,255,65],stderr:[...Buffer.from('worker warning\n')],code:0})
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({files,guestWasm})=>{
    const kernel=new window.sandboxLab.WorkerKernel(files)
    try{return await kernel.runModule('/worker-output-parent.mjs',{guestWasm,webAPIs:true,timeoutMs:15000})}finally{kernel.close()}
  },{files,guestWasm})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toBe(native.stdout)
  expect(result.stderr).toBe('')
})
test('worker unsupported runtime flags remain explicit',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':`
      import {Worker} from 'node:worker_threads';
      const results=[];
      for(const flag of ['--conditions=custom','--experimental-vm-modules']){
        try{new Worker('/child.mjs',{execArgv:[flag]});results.push('accepted')}
        catch(error){results.push(error.code)}
      }
      console.log(JSON.stringify(results));`,'/child.mjs':''})
    try{return await kernel.runModule('/main.mjs',{guestWasm:true,webAPIs:true})}finally{kernel.close()}
  })
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(['ERR_UNSUPPORTED_OPERATION','ERR_UNSUPPORTED_OPERATION'])
})
