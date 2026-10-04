import {expect,it,vi} from 'vitest'
import {NativeInputLifetime} from '../src/native/input-lifetime'
import {beginNodeCommandTimerActivity,keepNodeCommandAlive} from '../src/vite-browser/node-timers'

it('does not reference untouched stdin and releases exactly once after reads',()=>{
  const release=vi.fn(),keepAlive=vi.fn(()=>release)
  const lifetime=new NativeInputLifetime(keepAlive)
  expect(keepAlive).not.toHaveBeenCalled()
  lifetime.readRequested();lifetime.readRequested()
  expect(keepAlive).toHaveBeenCalledTimes(1)
  expect(release).not.toHaveBeenCalled()
  lifetime.finish();lifetime.finish();lifetime.readRequested()
  expect(release).toHaveBeenCalledTimes(1)
  expect(keepAlive).toHaveBeenCalledTimes(1)
})

it('holds real command activity until EOF or closure',async()=>{
  const activity=beginNodeCommandTimerActivity()
  try{
    const lifetime=new NativeInputLifetime(keepNodeCommandAlive)
    lifetime.readRequested()
    let idle=false
    const wait=activity.waitForIdle().then(()=>{idle=true})
    await new Promise(resolve=>setTimeout(resolve,5))
    expect(idle).toBe(false)
    lifetime.finish()
    await wait
    expect(idle).toBe(true)
  }finally{activity.stop()}
})

it('releases paused reads, ignores prefetch while paused and references a resumed read',()=>{
  const releases=[vi.fn(),vi.fn()],keepAlive=vi.fn().mockReturnValueOnce(releases[0]).mockReturnValueOnce(releases[1])
  const lifetime=new NativeInputLifetime(keepAlive)
  lifetime.readRequested();lifetime.pause();lifetime.pause();lifetime.readRequested()
  expect(releases[0]).toHaveBeenCalledTimes(1)
  expect(keepAlive).toHaveBeenCalledTimes(1)
  lifetime.resume();lifetime.resume()
  expect(keepAlive).toHaveBeenCalledTimes(2)
  lifetime.finish();lifetime.resume();lifetime.readRequested()
  expect(releases[1]).toHaveBeenCalledTimes(1)
  expect(keepAlive).toHaveBeenCalledTimes(2)
})
