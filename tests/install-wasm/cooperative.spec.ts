import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {guestWasmCases} from '../../fixtures/guest-wasm-cases.mjs'

test('cooperative engine yields during an infinite loop',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const url='/src/feasibility/cooperative-interrupt.ts'
    return (await import(/* @vite-ignore */url)).probeCooperativeInterrupt()
  })
  await info.attach('cooperative.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.crossOriginIsolated).toBe(false)
  expect(result.hostSharedArrayBuffer).toBe('undefined')
  expect(result.elapsedMs).toBeLessThan(1000)
  expect(result.recovered).toBe(42)
  expect(result.error.message).toBe('interrupted')
})

test('cooperative WASM corpus matches Node',async({page},info)=>{
  const control=Uint8Array.from(readFileSync('public/wasm-interpreter-probe/controls.wasm'))
  const md4=Uint8Array.from(readFileSync('public/wasm-interpreter-probe/webpack-md4.wasm'))
  const cases=guestWasmCases.map((fixture:{name:string;code:string})=>({...fixture,expected:runInNewContext(fixture.code,{control,md4,WebAssembly},{timeout:3000})}))
  await page.goto('/sandbox.html')
  const rows=await page.evaluate(async({cases,control,md4})=>{
    const url='/src/feasibility/cooperative-interrupt.ts'
    return (await import(/* @vite-ignore */url)).probeCooperativeCorpus(cases,control,md4)
  },{cases,control:[...control],md4:[...md4]})
  await info.attach('cooperative-wasm-corpus.json',{body:JSON.stringify(rows),contentType:'application/json'})
  expect(rows).toHaveLength(cases.length)
  expect(rows.filter((row:{passed:boolean})=>!row.passed)).toEqual([])
})

for(const wasm of [false,true])test('cooperative worker handles cancellation messages during a '+(wasm?'WASM':'JS')+' loop',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async wasm=>{
    const url='/src/feasibility/cooperative-worker.ts'
    return (await import(/* @vite-ignore */url)).probeCooperativeWorker(wasm)
  },wasm)
  await info.attach('cooperative-worker.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.crossOriginIsolated).toBe(false)
  expect(result.wasm).toBe(wasm)
  expect(result.hostSharedArrayBuffer).toBe('undefined')
  expect(result.messageToRecoveryMs).toBeLessThan(1000)
  expect(result.recovered).toBe(42)
  expect(result.error.message).toBe('interrupted')
})
