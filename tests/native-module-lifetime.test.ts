import {expect,test} from 'vitest'
import {awaitModuleEvaluation,UnsettledTopLevelAwait,ModuleLoadLifetime} from '../src/native/module-lifetime'
import {beginNodeCommandTimerActivity,keepNodeCommandAlive,trackNodeCommandPromise} from '../src/vite-browser/node-timers'

test('unresolved evaluation does not keep an idle command alive',async()=>{
  const activity=beginNodeCommandTimerActivity()
  try{
    await expect(awaitModuleEvaluation(new Promise(()=>{}),activity.waitForIdle)).rejects.toBeInstanceOf(UnsettledTopLevelAwait)
  }finally{activity.stop()}
})

test('referenced loading and I/O can resolve evaluation before idle',async()=>{
  const activity=beginNodeCommandTimerActivity()
  const release=keepNodeCommandAlive()
  try{
    const evaluation=new Promise<number>(resolve=>{
      void trackNodeCommandPromise(new Promise<void>(done=>setTimeout(done,15))).then(()=>{resolve(42);release()})
    })
    expect(await awaitModuleEvaluation(evaluation,activity.waitForIdle)).toBe(42)
  }finally{release();activity.stop()}
})

test('unresolved evaluation exits after referenced work finishes',async()=>{
  const activity=beginNodeCommandTimerActivity()
  const release=keepNodeCommandAlive()
  let fired=false
  try{
    setTimeout(()=>{fired=true;release()},15)
    await expect(awaitModuleEvaluation(new Promise(()=>{}),activity.waitForIdle)).rejects.toBeInstanceOf(UnsettledTopLevelAwait)
    expect(fired).toBe(true)
  }finally{release();activity.stop()}
})

test('resolved and rejected evaluations retain their original results',async()=>{
  const activity=beginNodeCommandTimerActivity()
  try{
    expect(await awaitModuleEvaluation(Promise.resolve(7),activity.waitForIdle)).toBe(7)
    const error=Error('owned rejection')
    await expect(awaitModuleEvaluation(Promise.reject(error),activity.waitForIdle)).rejects.toBe(error)
  }finally{activity.stop()}
})

test('queued imports stop being resources when evaluation starts, including cached imports',()=>{
  let active=0
  const loads=new ModuleLoadLifetime(()=>{active++;let released=false;return ()=>{if(!released){released=true;active--}}})
  const pending=new Promise<void>(()=>{})
  void loads.load('/app/dep.mjs',()=>pending)
  expect(active).toBe(1)
  loads.evaluating('/app/dep.mjs')
  expect(active).toBe(0)
  expect(loads.load('/app/dep.mjs',()=>pending)).toBe(pending)
  expect(active).toBe(0)
})

test('failed and completed module loading releases its resource',async()=>{
  let active=0
  const loads=new ModuleLoadLifetime(()=>{active++;return ()=>{active--}})
  const failure=Error('owned loading failure')
  expect(()=>loads.load('sync',()=>{throw failure})).toThrow(failure)
  expect(active).toBe(0)
  await expect(loads.load('async',()=>Promise.reject(failure))).rejects.toBe(failure)
  expect(active).toBe(0)
  expect(await loads.load('complete',()=>Promise.resolve(42))).toBe(42)
  expect(active).toBe(0)
})
