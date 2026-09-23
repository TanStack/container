import {test,expect} from '@playwright/test'

for(const guestWasm of [false,true])test(`bounded recursion recovers (${guestWasm?'WASM bridge':'default'})`,async({page},info)=>{
  await page.goto('/sandbox.html')
  const results=await page.evaluate(async guestWasm=>{
    const source=`let caught=0,depth=0;const depths=[];for(let i=0;i<3;i++){try{function recur(n){depth=n;return 1+recur(n+1)}recur(0)}catch(error){if(!/stack overflow/i.test(error.message))throw error;caught++;depths.push(depth)}}console.log(JSON.stringify({caught,depths,answer:6*7}));`
    const kernel=new window.sandboxLab.WorkerKernel({'/overflow.mjs':source,'/healthy.mjs':'console.log(42)'})
    try{return [await kernel.runModule('/overflow.mjs',{guestWasm,timeoutMs:5000}),await kernel.runModule('/healthy.mjs',{guestWasm})]}finally{kernel.close()}
  },guestWasm)
  await info.attach('stack-recovery.json',{body:JSON.stringify(results),contentType:'application/json'})
  expect(results[0].exitCode,results[0].stderr).toBe(0)
  const outcome=JSON.parse(results[0].stdout)
  console.log(JSON.stringify({guestWasm,...outcome}))
  expect(outcome).toMatchObject({caught:3,answer:42})
  expect(outcome.depths).toHaveLength(3)
  expect(outcome.depths.every((depth:number)=>depth>0)).toBe(true)
  expect(results[1].exitCode,results[1].stderr).toBe(0)
  expect(results[1].stdout).toBe('42\n')
})
