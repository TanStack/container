import {test,expect} from '@playwright/test'
import {source as directSource,spreadSource} from '../../fixtures/interpreter-frames.mjs'
for(const [name,source] of [['closures, arguments and unwinding',directSource],['deep spread calls',spreadSource]]){
const reference=new Function(source)()
for(const guestWasm of [false,true])test(`explicit interpreter frames preserve ${name} (${guestWasm?'WASM bridge':'default'})`,async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({source,guestWasm})=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/main.cjs':`console.log(JSON.stringify((function(){${source}})()))`})
    try{return await kernel.runModule('/main.cjs',{guestWasm,timeoutMs:10000})}finally{kernel.close()}
  },{source,guestWasm})
  await info.attach('interpreter-frames.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(reference)
})
}
