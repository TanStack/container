import {test,expect} from '@playwright/test'
import {execFileSync} from 'node:child_process'

test('VM context primitives | code generation policy, cross-realm ALS and deadlines',async({page},info)=>{
  const reference=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',`import {contextPrimitiveReference} from './scripts/context-primitives-reference.mjs';console.log(JSON.stringify(contextPrimitiveReference()))`],{encoding:'utf8',timeout:5000}))
  await page.goto('/sandbox.html')
  const report=await page.evaluate(reference=>new Promise<{
    error?:string;crossOriginIsolated:boolean;
    rounds:Array<Array<{name:string;actual:unknown;expected:unknown;matches:boolean}>>
  }>((resolve,reject)=>{
    const worker=new Worker('/tests/workloads/context-primitives.worker.js',{type:'module'})
    const timeout=setTimeout(()=>{worker.terminate();reject(Error('Context primitive worker timed out'))},30000)
    worker.onmessage=({data})=>{clearTimeout(timeout);worker.terminate();resolve(data)}
    worker.onerror=event=>{clearTimeout(timeout);worker.terminate();reject(Error(event.message))}
    worker.postMessage(reference)
  }),reference)
  await info.attach('context-primitives.json',{body:JSON.stringify({reference,...report}),contentType:'application/json'})
  expect(report.error).toBeUndefined()
  expect(report.crossOriginIsolated).toBe(false)
  expect(report.rounds).toHaveLength(3)
  for(const [index,round] of report.rounds.entries()){
    expect(round).toHaveLength(39)
    for(const row of round)expect(row.actual,'round '+index+': '+row.name).toEqual(row.expected)
  }
})
