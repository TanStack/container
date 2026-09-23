import {test,expect} from '@playwright/test'

test('WASM import profiling preserves callback results and thrown values',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const bytes=new Uint8Array(await (await fetch('/guest-wasm/callback.wasm')).arrayBuffer())
    const kernel=new window.sandboxLab.WorkerKernel({'/callback.wasm':bytes,'/main.mjs':`import {readFileSync} from 'node:fs';
      const marker={},module=new WebAssembly.Module(readFileSync('/callback.wasm'));
      let throwing=false;
      const e=new WebAssembly.Instance(module,{host:{callback(n){const until=Date.now()+80;while(Date.now()<until){};if(throwing)throw marker;return n+5}}}).exports;
      console.log(e.call(7));throwing=true;try{e.call(7)}catch(error){console.log(error===marker)};
    `})
    try{
      const ordinary=await kernel.runModule('/main.mjs',{guestWasm:true})
      const profiled=await kernel.runModule('/main.mjs',{guestWasm:true,profileJobs:true})
      return {ordinary,profiled,samples:kernel.jobProfile}
    }finally{kernel.close()}
  })
  expect(result.ordinary.exitCode,result.ordinary.stderr).toBe(0)
  expect(result.profiled.exitCode,result.profiled.stderr).toBe(0)
  expect(result.profiled.stdout).toBe(result.ordinary.stdout)
  expect(result.profiled.stdout).toContain('true')
  expect(result.samples.filter(row=>row.phase==='wasm-import'&&row.ms>=25)).toHaveLength(2)
  const calls=result.samples.filter(row=>row.phase==='wasm-call')
  expect(calls).toHaveLength(2)
  for(const call of calls){
    expect(call.imports).toBe(1)
    expect(call.importsMs).toBeGreaterThanOrEqual(25)
    expect(call.importsMs).toBeLessThanOrEqual(call.ms)
  }
})

test('single-job profiling reports completed jobs without changing their result',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':`await Promise.resolve().then(()=>{const until=Date.now()+80;while(Date.now()<until){};});console.log(42);`})
    try{
      const ordinary=await kernel.runModule('/main.mjs')
      const before=kernel.jobProfile.length
      const profiled=await kernel.runModule('/main.mjs',{profileJobs:true})
      return {ordinary,profiled,before,samples:kernel.jobProfile}
    }finally{kernel.close()}
  })
  expect(result.ordinary.exitCode,result.ordinary.stderr).toBe(0)
  expect(result.profiled.exitCode,result.profiled.stderr).toBe(0)
  expect(result.profiled.stdout).toBe(result.ordinary.stdout)
  expect(result.before).toBe(0)
  expect(result.samples.some(row=>row.phase==='job'&&row.jobs===1&&row.ms>=25)).toBe(true)
})

test('single-job profiling attributes a WASM call',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const bytes=new Uint8Array(await (await fetch('/guest-wasm/budget.wasm')).arrayBuffer())
    const kernel=new window.sandboxLab.WorkerKernel({'/budget.wasm':bytes,'/main.mjs':`import {readFileSync} from 'node:fs';const instance=new WebAssembly.Instance(new WebAssembly.Module(readFileSync('/budget.wasm')));console.log(instance.exports.finite(50000000));`})
    try{return {execution:await kernel.runModule('/main.mjs',{guestWasm:true,profileJobs:true,timeoutMs:15000}),samples:kernel.jobProfile}}finally{kernel.close()}
  })
  expect(result.execution.exitCode,result.execution.stderr).toBe(0)
  expect(result.execution.stdout.trim()).toBe('42')
  expect(result.samples.some(row=>row.phase==='wasm-call'&&row.ms>=25)).toBe(true)
})
