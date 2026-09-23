import {test,expect} from '@playwright/test'
// Run the deployed module-loader cases in installed Chrome as well as the
// three automation engines, alongside the existing lifecycle gate.
import '../e2e/kernel-modules.spec'

test('worker-owned files preserve native ALS and repeated real Start SSR',async({page},info)=>{
  const errors:string[]=[]
  page.on('pageerror',error=>errors.push(String(error)))
  page.on('crash',()=>errors.push('Page crashed'))
  page.on('console',message=>{if(message.text().startsWith('Kernel:'))console.log(message.text())})
  await page.goto('/sandbox.html')
  const report=await page.evaluate(()=>window.sandboxLab.runWorkerKernel(message=>{
    if(!message.startsWith('Installing'))console.log('Kernel:',message)
  }))
  expect(report.als).toHaveLength(34)
  expect(report.starts).toHaveLength(3)
  expect(report.asyncify).toBe(false)
  await page.waitForTimeout(20000)
  await expect(page.locator('h1')).toHaveText('Sandbox feasibility lab')
  expect(errors).toEqual([])
  await info.attach('worker-kernel.json',{body:JSON.stringify(report),contentType:'application/json'})
})

test('worker owner enforces guest authority, limits, exclusivity, and recovery',async({page})=>{
  const errors:string[]=[]
  page.on('pageerror',error=>errors.push(String(error)))
  await page.goto('/sandbox.html')
  const report=await page.evaluate(async()=>{
    const early=new window.sandboxLab.WorkerKernel()
    early.close()
    const earlyClosed=await early.snapshot().then(()=>false,error=>String(error).includes('Kernel closed'))
    const k=new window.sandboxLab.WorkerKernel({'/value':'retained'})
    try{
      await k.writeText('/main.mjs',`import {writeFileSync,readFileSync} from 'node:fs';
        const errors=[];for(const fn of [()=>writeFileSync('/denied','x'),()=>readFileSync('../escape')]){
          try{fn()}catch(e){errors.push(e.message)}
        }console.log(JSON.stringify({errors,ambient:[typeof fetch,typeof document,typeof Worker,typeof __qjsGetAsyncContext]}));`)
      const authority=await k.run('/main.mjs',{writable:false})
      const snapshot=await k.snapshot()
      snapshot.files['/value'].fill(0)
      const copied=await k.readText('/value')
      const loop=await k.execute('await 0;for(;;){}',{timeoutMs:100})
      const heap=await k.execute('new Uint8Array(2*1024*1024)',{maxBytes:1024*1024})
      const unresolved=await k.execute('await new Promise(()=>{})',{timeoutMs:100})
      const recovery=await k.execute(`console.log(42)`)
      let concurrent:Promise<unknown>|undefined
      await k.execute(`console.log('active');await new Promise(r=>setTimeout(r,100));`,{
        onOutput:()=>{concurrent=k.execute('console.log(1)').then(()=>false,error=>String(error))},
      })
      let canceled=false
      try{await k.execute(`console.log('close');await new Promise(()=>{})`,{onOutput:()=>k.close()})}
      catch(error){canceled=String(error).includes('Kernel closed')}
      return {authority,denied:!!snapshot.files['/denied'],copied,loop,heap,unresolved,recovery,concurrent:await concurrent,canceled,earlyClosed}
    }finally{k.close()}
  })
  expect(report.authority.exitCode,report.authority.stderr).toBe(0)
  const value=JSON.parse(report.authority.stdout)
  expect(value.errors).toHaveLength(2)
  expect(value.errors[0]).toContain('read-only')
  expect(value.errors[1]).toContain('EACCES')
  expect(value.ambient).toEqual(['undefined','undefined','undefined','undefined'])
  expect(report.denied).toBe(false)
  expect(report.copied).toBe('retained')
  expect(report.loop.exitCode).toBe(1)
  expect(report.loop.stderr).toMatch(/interrupt|timed out/)
  expect(report.heap.exitCode).toBe(1)
  expect(report.heap.stderr).toMatch(/memory/)
  expect(report.unresolved.exitCode).toBe(1)
  expect(report.recovery.exitCode).toBe(0)
  expect(report.recovery.stdout.trim()).toBe('42')
  expect(report.concurrent).toContain('active execution')
  expect(report.canceled).toBe(true)
  expect(report.earlyClosed).toBe(true)
  expect(errors).toEqual([])
})
