import {test,expect} from 'vitest'
import {readFileSync} from 'node:fs'
import {applyWasmMemoryPolicy} from '../src/compiler/wasm-memory-policy'

const moduleBytes=(memory:number[])=>new Uint8Array([0,97,115,109,1,0,0,0,5,memory.length,...memory,7,7,1,3,109,101,109,2,0])
test('ordinary exported memory grows only through the declared budget',async()=>{
  const original=moduleBytes([1,0,1]),saved=original.slice()
  const result=applyWasmMemoryPolicy(original,2)
  expect(original).toEqual(saved)
  expect(result).toMatchObject({minPages:1,originalMaxPages:null,declaredMaxPages:2})
  const {instance}=await WebAssembly.instantiate(result.bytes)
  const memory=instance.exports.mem as WebAssembly.Memory
  expect(memory.grow(1)).toBe(1)
  expect(()=>memory.grow(1)).toThrow(RangeError)
  expect(memory.buffer.byteLength).toBe(2*65536)
})
test('lower existing maximum remains in force',()=>{
  const result=applyWasmMemoryPolicy(moduleBytes([1,1,1,2]),4)
  expect(result.originalMaxPages).toBe(2);expect(result.declaredMaxPages).toBe(2)
  expect(WebAssembly.validate(result.bytes)).toBe(true)
})
test('WASM memory.grow instruction also respects the prepared maximum',async()=>{
  const original=new Uint8Array([
    0,97,115,109,1,0,0,0,
    1,6,1,96,1,127,1,127, // (i32) -> i32
    3,2,1,0,
    5,3,1,0,1,
    7,8,1,4,103,114,111,119,0,0,
    10,8,1,6,0,32,0,64,0,11,
  ])
  const {instance}=await WebAssembly.instantiate(applyWasmMemoryPolicy(original,2).bytes)
  const grow=instance.exports.grow as (pages:number)=>number
  expect(grow(1)).toBe(1)
  expect(grow(1)).toBe(-1)
  expect(grow(0)).toBe(2)
})
test('unsupported memory and import forms fail explicitly',()=>{
  expect(()=>applyWasmMemoryPolicy(moduleBytes([1,0,3]),2)).toThrow('minimum')
  expect(()=>applyWasmMemoryPolicy(moduleBytes([1,3,1,2]),2)).toThrow('nonshared')
  expect(()=>applyWasmMemoryPolicy(moduleBytes([2,0,1,0,1]),2)).toThrow('exactly one')
  const imported=new Uint8Array([0,97,115,109,1,0,0,0,2,6,1,0,0,2,0,1])
  expect(()=>applyWasmMemoryPolicy(imported,2)).toThrow('function imports')
})
test('exact installed esbuild 0.28.2 retains a valid module with its 95-page minimum',()=>{
  const pkg=JSON.parse(readFileSync('node_modules/esbuild-wasm/package.json','utf8'))
  expect(pkg.version).toBe('0.28.2')
  const original=new Uint8Array(readFileSync('node_modules/esbuild-wasm/esbuild.wasm'))
  const result=applyWasmMemoryPolicy(original,1024)
  expect(result).toMatchObject({minPages:95,originalMaxPages:null,declaredMaxPages:1024})
  expect(WebAssembly.validate(result.bytes)).toBe(true)
  expect(()=>applyWasmMemoryPolicy(original,94)).toThrow('minimum')
})
