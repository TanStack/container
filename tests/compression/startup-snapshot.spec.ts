import {test,expect} from '@playwright/test'
import {spawnSync} from 'node:child_process'

test('startup snapshot capability reports normal runtime mode without accepting callbacks',async({page})=>{
  const source=`import v8 from 'node:v8';const result=[v8.startupSnapshot.isBuildingSnapshot()];for(const name of ['addSerializeCallback','addDeserializeCallback','setDeserializeMainFunction']){try{v8.startupSnapshot[name](()=>{})}catch(error){result.push(error.code)}}console.log(JSON.stringify(result));`
  const node=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:5000});expect(node.status,node.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async source=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source});try{return await kernel.runModule('/main.mjs',{guestWasm:true})}finally{kernel.close()}
  },source)
  expect(result.exitCode,result.stderr).toBe(0);expect(result.stdout).toBe(node.stdout)
})
