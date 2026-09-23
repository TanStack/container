import {test,expect} from '@playwright/test'

test('VM allocator | aggregate budgets and failed context creation recover',async({page},info)=>{
  await page.goto('/sandbox.html')
  const report=await page.evaluate(()=>new Promise<{
    error?:string;accounting:{rows:Array<{name:string;enforced:boolean}>};allocation:Array<{failed:boolean;recovery:number}>
  }>((resolve,reject)=>{
    const worker=new Worker('/tests/workloads/allocator.worker.js',{type:'module'})
    const timeout=setTimeout(()=>{worker.terminate();reject(Error('Allocator worker timed out'))},45000)
    worker.onmessage=({data})=>{clearTimeout(timeout);worker.terminate();resolve(data)}
    worker.onerror=event=>{clearTimeout(timeout);worker.terminate();reject(Error(event.message))}
    worker.postMessage(null)
  }))
  await info.attach('allocator.json',{body:JSON.stringify(report),contentType:'application/json'})
  expect(report.error).toBeUndefined()
  for(const row of report.accounting.rows)expect(row.enforced,row.name).toBe(true)
  expect(report.allocation).toHaveLength(1025)
  expect(report.allocation.some(row=>row.failed)).toBe(true)
  expect(report.allocation.some(row=>!row.failed)).toBe(true)
  expect(report.allocation.every(row=>row.recovery===42)).toBe(true)
})
