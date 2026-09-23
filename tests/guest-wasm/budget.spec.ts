import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'

const bytes=[...readFileSync('public/guest-wasm/budget.wasm')]
const prelude=`const e=new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(${JSON.stringify(bytes)}))).exports;`

const testOptimization=process.env.WASM_TEST_OPT
if(testOptimization&&testOptimization!=='o2')throw Error('Unsupported WASM_TEST_OPT')
test.beforeEach(async({context},info)=>{
  if(!testOptimization)return
  const directory=`public/quickjs-als-wasm-${testOptimization}`
  await info.attach('alternate-engine.json',{body:readFileSync(`${directory}/build.json`),contentType:'application/json'})
  for(const name of ['core.mjs','engine.mjs','engine.wasm']){
    const response=await context.request.get(`/quickjs-als-wasm/${name}`)
    expect(response.ok()).toBe(true)
    expect(response.headers()['x-sandbox-engine-variant']).toBe(testOptimization)
    expect((await response.body()).equals(readFileSync(`${directory}/${name}`))).toBe(true)
  }
})

test('finite WASM cold and warm execution retains the host deadline',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async prelude=>{
    const kernel=new window.sandboxLab.WorkerKernel()
    try{
      const execution=await kernel.execute(prelude+`
        const timings=[];
        for(let n=0;n<4;n++){
          const start=Date.now();const answer=e.finite(50000000);
          if(answer!==42)throw Error('Unexpected result');
          timings.push(Date.now()-start);
        }
        console.log(JSON.stringify(timings));
      `,{guestWasm:true,timeoutMs:15000,profileJobs:true})
      return {execution,samples:kernel.jobProfile}
    }finally{kernel.close()}
  },prelude)
  await info.attach('wasm-cold-warm.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.execution.exitCode,result.execution.stderr).toBe(0)
  const timings=JSON.parse(result.execution.stdout.trim()) as number[]
  expect(timings).toHaveLength(4)
  expect(timings.every(ms=>Number.isFinite(ms)&&ms>=0)).toBe(true)
  console.log(info.project.name,'finite WASM milliseconds',timings)
  const calls=result.samples.filter(row=>row.phase==='wasm-call').sort((a,b)=>a.at-b.at)
  expect(calls).toHaveLength(4)
  for(let n=0;n<calls.length;n++){
    expect(calls[n].interruptCalls).toBeGreaterThan(n?calls[n-1].interruptCalls!:0)
    expect(calls[n].interruptMs).toBeGreaterThanOrEqual(0)
  }
  console.log(info.project.name,'cumulative host interrupt samples',calls.map(({interruptCalls,interruptMs})=>({interruptCalls,interruptMs})))
})

test('host deadline permits finite WASM work beyond the fallback instruction allowance',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async prelude=>{
    const kernel=new window.sandboxLab.WorkerKernel()
    try{return await kernel.execute(prelude+'console.log(e.finite(50000000));',{guestWasm:true,timeoutMs:10000})}finally{kernel.close()}
  },prelude)
  await info.attach('wasm-budget-finite.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toBe('42\n')
})

test('WASM deadlines stop promise jobs and cannot be caught by the guest',async({page},info)=>{
  await page.goto('/sandbox.html')
  const results=await page.evaluate(async prelude=>{
    const kernel=new window.sandboxLab.WorkerKernel()
    try{
      const rows=[]
      for(const profileJobs of [false,true])for(const code of [
        'try{e.loop()}catch(error){console.log("escaped")}console.log("continued")',
        'await Promise.resolve().then(()=>{try{e.loop()}catch(error){console.log("escaped")}});console.log("continued")',
      ])rows.push(await kernel.execute(prelude+code,{guestWasm:true,timeoutMs:150,profileJobs}))
      const recovery=await kernel.execute(prelude+'console.log(e.answer())',{guestWasm:true})
      return {rows,recovery}
    }finally{kernel.close()}
  },prelude)
  await info.attach('wasm-budget-deadlines.json',{body:JSON.stringify(results),contentType:'application/json'})
  for(const row of results.rows){
    expect(row.exitCode).not.toBe(0)
    expect(row.stderr).toMatch(/interrupted|timed out/i)
    expect(row.stderr).not.toMatch(/gas/i)
    expect(row.stdout).toBe('')
  }
  expect(results.recovery.exitCode,results.recovery.stderr).toBe(0)
  expect(results.recovery.stdout).toBe('42\n')
})
