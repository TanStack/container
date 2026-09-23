import {test,expect,vi} from 'vitest'
import {withStartupDeadline} from '../src/sandbox/startup-deadline'

test('expires a held startup and cleans its timer and parent listener',async()=>{
  vi.useFakeTimers()
  try{
    const parent=new AbortController(),remove=vi.spyOn(parent.signal,'removeEventListener')
    let signal:AbortSignal|undefined
    const pending=withStartupDeadline(parent.signal,50,async value=>{signal=value;return new Promise(()=>{})})
    const assertion=expect(pending).rejects.toMatchObject({code:'ERR_ENGINE_STARTUP_TIMEOUT'})
    await vi.advanceTimersByTimeAsync(50);await assertion
    expect(signal?.aborted).toBe(true);expect(vi.getTimerCount()).toBe(0);expect(remove).toHaveBeenCalledOnce()
  }finally{vi.useRealTimers()}
})

test('cleans up successful and failed startup',async()=>{
  vi.useFakeTimers()
  try{
    const parent=new AbortController()
    expect(await withStartupDeadline(parent.signal,50,async()=>42)).toBe(42)
    await expect(withStartupDeadline(parent.signal,50,async()=>{throw Error('failed')})).rejects.toThrow('failed')
    expect(vi.getTimerCount()).toBe(0)
  }finally{vi.useRealTimers()}
})

test('parent cancellation prevents a queued startup operation',async()=>{
  const parent=new AbortController(),operation=vi.fn(async()=>42)
  const pending=withStartupDeadline(parent.signal,1000,operation)
  parent.abort('stopped')
  await expect(pending).rejects.toBe('stopped')
  expect(operation).not.toHaveBeenCalled()
})

test('rejects a late result even before the timer can run',async()=>{
  const now=vi.spyOn(performance,'now').mockReturnValue(0)
  try{
    await expect(withStartupDeadline(new AbortController().signal,50,async()=>{
      now.mockReturnValue(51);return 42
    })).rejects.toMatchObject({code:'ERR_ENGINE_STARTUP_TIMEOUT'})
  }finally{now.mockRestore()}
})
