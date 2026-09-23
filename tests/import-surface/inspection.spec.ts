import {test,expect} from '@playwright/test'
import {spawnSync} from 'node:child_process'
import {inspectionCases} from '../../fixtures/inspection-cases.mjs'

for(const guestWasm of [false,true])for(const [name,source] of Object.entries(inspectionCases)){
  test(`${guestWasm?'WASM bridge':'default engine'}: ${name}`,async({page},info)=>{
    const node=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:10000})
    expect(node.status,node.stderr).toBe(0)
    await page.goto('/sandbox.html')
    const result=await page.evaluate(async({source,guestWasm})=>{
      const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source})
      try{return await kernel.runModule('/main.mjs',{guestWasm,webAPIs:true,maxBytes:64*1024*1024})}finally{kernel.close()}
    },{source,guestWasm})
    await info.attach('node-comparison.json',{body:JSON.stringify({node:node.stdout,nodeVersion:process.version,result}),contentType:'application/json'})
    expect(result.exitCode,result.stderr).toBe(0)
    expect(result.stdout).toBe(node.stdout)
  })
}
