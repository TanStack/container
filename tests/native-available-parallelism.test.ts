import {afterEach,expect,test,vi} from 'vitest'
import {availableParallelism} from '../src/native/available-parallelism'
afterEach(()=>vi.unstubAllGlobals())
test('uses the runtime browser parallelism hint',()=>{
  vi.stubGlobal('navigator',{hardwareConcurrency:8})
  expect(availableParallelism()).toBe(8)
})
test('uses one execution lane when the browser supplies no valid hint',()=>{
  for(const value of [undefined,0,-1,NaN,Infinity,'8']){
    vi.stubGlobal('navigator',{hardwareConcurrency:value})
    expect(availableParallelism()).toBe(1)
  }
})
