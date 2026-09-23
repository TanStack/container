import {it,expect,vi} from 'vitest'
import {createWasmModuleTiming} from '../src/sandbox/wasm-module-timing'

it('does not enable timing on old engines',()=>{
  expect(createWasmModuleTiming({})).toBeUndefined()
})
it('arms each measurement, aggregates scalars and returns independent snapshots',()=>{
  const reset=vi.fn(),values=[1,2,3,4,100,1]
  const timing=createWasmModuleTiming({_QTS_WasmModuleTimingReset:reset,_QTS_WasmModuleTimingRead:i=>values[i]})!
  timing.begin();timing.end();const first=timing.snapshot()
  values[5]=0;timing.begin();timing.end()
  expect(reset.mock.calls).toEqual([[1],[0],[1],[0]])
  expect(first).toEqual({copyMs:1,setupMs:2,parseMs:3,validationMs:4,sourceBytes:100,calls:1,validated:1})
  expect(timing.snapshot()).toEqual({copyMs:2,setupMs:4,parseMs:6,validationMs:8,sourceBytes:200,calls:2,validated:1})
})
it('disarms after invalid or failed reads without adding partial measurements',()=>{
  const reset=vi.fn(),read=vi.fn(()=>NaN)
  const timing=createWasmModuleTiming({_QTS_WasmModuleTimingReset:reset,_QTS_WasmModuleTimingRead:read})!
  timing.begin();timing.end();expect(timing.snapshot().calls).toBe(0)
  read.mockImplementation(()=>{throw Error('read failed')})
  timing.begin();expect(()=>timing.end()).toThrow('read failed')
  expect(reset.mock.calls).toEqual([[1],[0],[1],[0]])
})
it('collects reset timing only when the native schema supports it',()=>{
  const values=[1,2,3,4,100,1,0.5,12,4096],reset=vi.fn()
  const timing=createWasmModuleTiming({_QTS_WasmModuleTimingReset:reset,_QTS_WasmModuleTimingRead:i=>i===-1?9:values[i]})!
  timing.begin();timing.end();timing.begin();timing.end()
  expect(timing.snapshot()).toMatchObject({resetMs:1,resetCalls:24,resetBytes:8192,calls:2})
})
