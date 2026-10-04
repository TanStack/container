import {expect,test} from 'vitest'
import {loadBrowserVmModule} from '../src/native/browser-vm-module'
import {beginNodeCommandTimerActivity} from '../src/vite-browser/node-timers'

test('pending VM module loading keeps the command alive until I/O settles',async()=>{
  const activity=beginNodeCommandTimerActivity()
  let finish!:(value:number)=>void
  const pending=loadBrowserVmModule(()=>new Promise<number>(resolve=>{finish=resolve}))
  let idle=false
  const wait=activity.waitForIdle().then(()=>{idle=true})
  try{
    await new Promise(resolve=>setTimeout(resolve,10))
    expect(idle).toBe(false)
    finish(42)
    expect(await pending).toBe(42)
    await wait
    expect(idle).toBe(true)
  }finally{finish(42);activity.stop();await wait}
})

test('failed VM module loading releases I/O and keeps the original error',async()=>{
  const activity=beginNodeCommandTimerActivity(),reason=Error('owned import failure')
  try{
    await expect(loadBrowserVmModule(()=>Promise.reject(reason))).rejects.toBe(reason)
    await activity.waitForIdle()
  }finally{activity.stop()}
})

test('VM module loading outside a command preserves the loader promise',async()=>{
  const pending=Promise.resolve(42)
  expect(loadBrowserVmModule(()=>pending)).toBe(pending)
})
