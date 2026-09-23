import {test,expect} from '@playwright/test'
import {execFileSync} from 'node:child_process'

test('VM context globals | live sandbox bridge matches Node without shared memory',async({page},info)=>{
  const reference=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',`import {contextGlobalsReference} from './scripts/context-globals-reference.mjs';import {contextPrimitiveReference} from './scripts/context-primitives-reference.mjs';console.log(JSON.stringify({reference:contextGlobalsReference(),primitives:contextPrimitiveReference()}))`],{encoding:'utf8',timeout:10000}))
  await page.goto('/sandbox.html')
  const report=await page.evaluate(reference=>new Promise<{
    error?:string;crossOriginIsolated:boolean;wasmHeapBytes:number;
    rounds:Array<{globals:Array<{name:string;actual:unknown;expected:unknown}>,primitives:Array<{name:string;actual:unknown;expected:unknown}>}>
  }>((resolve,reject)=>{
    const worker=new Worker('/tests/workloads/context-globals.worker.js',{type:'module'})
    const timeout=setTimeout(()=>{worker.terminate();reject(Error('Context global worker timed out'))},45000)
    worker.onmessage=({data})=>{clearTimeout(timeout);worker.terminate();resolve(data)}
    worker.onerror=event=>{clearTimeout(timeout);worker.terminate();reject(Error(event.message))}
    worker.postMessage(reference)
  }),reference)
  await info.attach('context-globals.json',{body:JSON.stringify({reference,...report}),contentType:'application/json'})
  expect(report.error).toBeUndefined()
  expect(report.crossOriginIsolated).toBe(false)
  expect(report.rounds).toHaveLength(3)
  for(const [index,round] of report.rounds.entries()){
    expect(round.globals).toHaveLength(Object.keys(reference.reference).length)
    expect(round.primitives).toHaveLength(39)
    for(const row of [...round.globals,...round.primitives])expect(row.actual,'round '+index+': '+row.name).toEqual(row.expected)
  }
})
