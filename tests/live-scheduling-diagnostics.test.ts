import {test,expect,vi} from 'vitest'
import {createLiveSchedulingDiagnostics,createFiberPhaseTiming} from '../src/sandbox/live-scheduling-diagnostics'

test('fiber timing distinguishes fixed phases and preserves independent snapshots',()=>{
  const timing=createFiberPhaseTiming()
  expect(timing.snapshot().lastStep).toBeUndefined()
  timing.observe('evaluation',10,2)
  timing.observe('jobs',30,3)
  timing.observe('jobs',20,2)
  timing.observe('nextTick',5,undefined)
  const first=timing.snapshot()
  expect(first.lastStep).toEqual({phase:'nextTick',durationMs:5,status:undefined})
  expect(first.byPhase).toEqual({evaluation:{steps:1,totalMs:10,maxMs:10},jobs:{steps:2,totalMs:50,maxMs:30},nextTick:{steps:1,totalMs:5,maxMs:5}})
  timing.observe('jobs',40,2)
  expect(first.byPhase.jobs).toEqual({steps:2,totalMs:50,maxMs:30})
  expect(timing.snapshot().byPhase.jobs).toEqual({steps:3,totalMs:90,maxMs:40})
  expect(timing.snapshot().lastStep).toEqual({phase:'jobs',durationMs:40,status:2})
  first.byPhase.evaluation.steps=999
  expect(timing.snapshot().byPhase.evaluation.steps).toBe(1)
})

test('passive samples are limited to one per second and 64 per execution',()=>{
  let now=0
  const sample=vi.fn(),clock=vi.fn(()=>now)
  const observe=createLiveSchedulingDiagnostics(sample,clock)
  observe();observe()
  now=999;observe()
  expect(sample).toHaveBeenCalledTimes(1)
  now=1000;observe()
  expect(sample).toHaveBeenLastCalledWith(1000,2)
  for(let index=2;index<100;index++){now=index*1000;observe()}
  expect(sample).toHaveBeenCalledTimes(64)
  expect(sample).toHaveBeenLastCalledWith(63000,64)
  const clocks=clock.mock.calls.length
  observe()
  expect(clock).toHaveBeenCalledTimes(clocks)
})

test('observer failures are isolated and still consume the sample budget',()=>{
  let now=0
  const sample=vi.fn(()=>{throw Error('observer failed')})
  const observe=createLiveSchedulingDiagnostics(sample,()=>now)
  expect(observe).not.toThrow()
  observe()
  expect(sample).toHaveBeenCalledTimes(1)
  now=1000
  expect(observe).not.toThrow()
  expect(sample).toHaveBeenCalledTimes(2)
})

test('sampling creates no timers or asynchronous work',()=>{
  vi.useFakeTimers()
  try{
    const sample=vi.fn(),observe=createLiveSchedulingDiagnostics(sample,()=>0)
    expect(sample).not.toHaveBeenCalled()
    observe()
    expect(sample).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  }finally{vi.useRealTimers()}
})
