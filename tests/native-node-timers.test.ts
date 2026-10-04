import { expect, test } from 'vitest'
import { installNodeTimerHandles } from '../src/vite-browser/node-timers'

test('worker timers expose Node handles while preserving cancellation', async () => {
  const original = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setImmediate: globalThis.setImmediate,
    clearImmediate: globalThis.clearImmediate,
  }
  try {
    installNodeTimerHandles()
    let fired = false
    const cancelled = setTimeout(() => { fired = true }, 5)
    expect(cancelled.hasRef()).toBe(true)
    expect(cancelled.unref()).toBe(cancelled)
    expect(cancelled.hasRef()).toBe(false)
    expect(cancelled.ref().hasRef()).toBe(true)
    clearTimeout(cancelled)
    await new Promise<void>(resolve => original.setTimeout(resolve, 15))
    expect(fired).toBe(false)

    let intervalCalls = 0
    const interval = setInterval(() => { intervalCalls++ }, 2)
    await new Promise<void>(resolve => original.setTimeout(resolve, 12))
    clearInterval(interval)
    expect(intervalCalls).toBeGreaterThan(0)

    let immediateValue=0
    const immediate=setImmediate((value:number)=>{immediateValue=value},42)
    expect(immediate.hasRef()).toBe(true)
    await new Promise<void>(resolve=>original.setTimeout(resolve,5))
    expect(immediateValue).toBe(42)
    const cancelledImmediate=setImmediate(()=>{immediateValue=100})
    clearImmediate(cancelledImmediate)
    await new Promise<void>(resolve=>original.setTimeout(resolve,5))
    expect(immediateValue).toBe(42)
  } finally {
    Object.assign(globalThis, original)
  }
})
