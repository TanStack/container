import {afterEach,expect,test} from 'vitest'
import {startInstallPhase,traceInstallPhase,traceAsyncInstallPhase} from '../src/npm/install-phase-trace'
afterEach(()=>{delete globalThis.__sandboxInstallPhaseTrace})
test('dormant tracing returns exact value synchronously',()=>{
  const value={answer:42}
  expect(traceInstallPhase('install-planning',()=>value)).toBe(value)
})
test('reports fixed stage boundaries without operation payload',()=>{
  const events:unknown[][]=[]
  globalThis.__sandboxInstallPhaseTrace=(...args)=>{events.push(args);return 7}
  traceInstallPhase('workspace-staging',()=>({secret:'not reported'}))
  expect(events).toEqual([['workspace-staging','begin',undefined],['workspace-staging','end',7]])
})
test('retains exact operation exception and records error',()=>{
  const events:unknown[][]=[],failure=new Error('original')
  globalThis.__sandboxInstallPhaseTrace=(...args)=>{events.push(args);return 8}
  expect(()=>traceInstallPhase('tar-extraction',()=>{throw failure})).toThrow(failure)
  expect(events).toEqual([['tar-extraction','begin',undefined],['tar-extraction','error',8]])
})
test('observer failure cannot replace operation result or error',()=>{
  globalThis.__sandboxInstallPhaseTrace=()=>{throw Error('observer')}
  expect(traceInstallPhase('workspace-commit',()=>42)).toBe(42)
  const failure=new Error('operation')
  expect(()=>traceInstallPhase('workspace-commit',()=>{throw failure})).toThrow(failure)
})
test('explicit span follows existing asynchronous loop and retains failure',async()=>{
  const events:unknown[][]=[]
  globalThis.__sandboxInstallPhaseTrace=(...args)=>{events.push(args);return 9}
  const failure=new Error('write failed')
  async function loop(fail:boolean){
    const finish=startInstallPhase('package-file-write')
    try{
      for(const value of [1,2]){await Promise.resolve(value);if(fail)throw failure}
      finish('end')
    }catch(error){finish('error');throw error}
  }
  await loop(false)
  await expect(loop(true)).rejects.toBe(failure)
  expect(events).toEqual([
    ['package-file-write','begin',undefined],['package-file-write','end',9],
    ['package-file-write','begin',undefined],['package-file-write','error',9],
  ])
})
test('dormant span is synchronous and completion is harmless',()=>{
  const finish=startInstallPhase('package-file-write')
  expect(finish('end')).toBeUndefined()
})
test('async tracing keeps the span open until settlement and retains errors',async()=>{
  const events:unknown[][]=[]
  globalThis.__sandboxInstallPhaseTrace=(...args)=>{events.push(args);return 10}
  let release!:(value:number)=>void
  const pending=traceAsyncInstallPhase('archive-download',()=>new Promise<number>(resolve=>{release=resolve}))
  expect(events).toEqual([['archive-download','begin',undefined]])
  release(42)
  await expect(pending).resolves.toBe(42)
  expect(events.at(-1)).toEqual(['archive-download','end',10])
  const failure=Error('cache failed')
  await expect(traceAsyncInstallPhase('archive-cache-read',async()=>{throw failure})).rejects.toBe(failure)
  expect(events.at(-1)).toEqual(['archive-cache-read','error',10])
})
test('decompression tracing preserves bytes and original failure',async()=>{
  const events:unknown[][]=[],bytes=new Uint8Array([0,128,255]),failure=Error('invalid gzip')
  globalThis.__sandboxInstallPhaseTrace=(...args)=>{events.push(args);return 11}
  expect(await traceAsyncInstallPhase('gzip-decompression',async()=>bytes)).toBe(bytes)
  await expect(traceAsyncInstallPhase('gzip-decompression',async()=>{throw failure})).rejects.toBe(failure)
  expect(events).toEqual([
    ['gzip-decompression','begin',undefined],['gzip-decompression','end',11],
    ['gzip-decompression','begin',undefined],['gzip-decompression','error',11],
  ])
})
test('bounds diagnostic events without skipping operations',()=>{
  let calls=0,operations=0
  globalThis.__sandboxInstallPhaseTrace=()=>{calls++;return undefined}
  for(let i=0;i<3000;i++)traceInstallPhase('tar-extraction',()=>{operations++})
  expect(calls).toBeLessThanOrEqual(2048)
  expect(operations).toBe(3000)
})
