import {expect,it} from 'vitest'
import {beginNodeCommandTimerActivity,installNodeTimerHandles} from '../src/vite-browser/node-timers'

it('does not finish between a timer callback and new work queued by its promises',async()=>{
  const originals={setTimeout,clearTimeout,setInterval,clearInterval,setImmediate,clearImmediate}
  installNodeTimerHandles()
  const activity=beginNodeCommandTimerActivity()
  let next:ReturnType<typeof setTimeout>|undefined
  try{
    let finished=false
    setTimeout(()=>{
      void Promise.resolve().then(()=>Promise.resolve()).then(()=>{
        next=setTimeout(()=>{finished=true},15)
      })
    },5)
    await activity.waitForIdle()
    expect(finished).toBe(true)
  }finally{
    if(next!==undefined)clearTimeout(next)
    activity.stop();Object.assign(globalThis,originals)
  }
})

it('waits for referenced command timers and ignores unrefed handles',async()=>{
  const originals={setTimeout,clearTimeout,setInterval,clearInterval,setImmediate,clearImmediate}
  installNodeTimerHandles()
  const activity=beginNodeCommandTimerActivity()
  try{
    let fired=false
    setTimeout(()=>{fired=true},15)
    await activity.waitForIdle()
    expect(fired).toBe(true)
    const interval=setInterval(()=>{},1000)
    interval.unref()
    await activity.waitForIdle()
    clearInterval(interval)
    const immediate=setImmediate(()=>{fired=true})
    await activity.waitForIdle()
    expect(immediate.hasRef()).toBe(true)
  }finally{
    activity.stop()
    Object.assign(globalThis,originals)
  }
})

it('waits for referenced command network handles until they close',async()=>{
  const activity=beginNodeCommandTimerActivity()
  const hooks=globalThis as unknown as Record<symbol,((handle:object,active:boolean)=>void)|undefined>
  const symbol=Symbol.for('web-container:command-handle')
  const handle={}
  try{
    hooks[symbol]?.(handle,true)
    let idle=false
    const wait=activity.waitForIdle().then(()=>{idle=true})
    await Promise.resolve()
    expect(idle).toBe(false)
    hooks[symbol]?.(handle,false)
    await wait
    expect(idle).toBe(true)
  }finally{activity.stop()}
  expect(hooks[symbol]).toBeUndefined()
})
