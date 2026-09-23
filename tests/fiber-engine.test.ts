import {describe,expect,it,vi} from 'vitest'
import {runKernelFiber,type KernelFiber} from '../src/sandbox/fiber-engine'
import {TaskScheduler} from '../src/sandbox/task-scheduler'
import {EngineAccess} from '../src/sandbox/engine-access'

function fakeFiber(waits:number){
  let state=0,ready=false,cancelled=false,taken=false,disposed=false
  const events:string[]=[]
  const resultDispose=vi.fn()
  const result={dispose:resultDispose} as unknown as ReturnType<KernelFiber['takeResult']>
  const fiber:KernelFiber={
    step(){
      if(disposed)throw Error('Disposed fiber entered')
      events.push('step')
      if(cancelled)state=2
      else if(state===0)state=waits>0?1:2
      else if(state===1&&ready){ready=false;state=--waits>0?1:2}
      return state
    },
    status:()=>state,
    deliver(value){
      events.push('deliver:'+value)
      if(state!==1||ready||cancelled)return false
      ready=true;return true
    },
    cancel(){events.push('cancel');if(state===2||cancelled)return false;cancelled=true;return true},
    takeResult(){
      if(state!==2||taken)throw Error('Invalid or duplicate result transfer')
      events.push('take');taken=true;return result
    },
    dispose(){
      if(state!==2||!taken||disposed)throw Error('Disposed before unwind or duplicate disposal')
      events.push('dispose');disposed=true
    },
  }
  return {fiber,events,result,resultDispose}
}

describe('experimental kernel fiber host waits',()=>{
  it('keeps runtime ownership across fairness checkpoints without delivering a timer value',async()=>{
    const scheduler=new TaskScheduler(),access=new EngineAccess(),fake=fakeFiber(0),takeWait=vi.fn(),events:string[]=[]
    const step=fake.fiber.step
    fake.fiber.step=vi.fn().mockImplementationOnce(()=>3).mockImplementation(step)
    const checkpoint=vi.spyOn(scheduler,'checkpoint').mockImplementation(async()=>{
      events.push('peer host task');expect(access.busy).toBe(true)
      access.enqueue(()=>events.push('guest completion'))
      expect(()=>access.drain()).toThrow('Cannot drain')
      await Promise.resolve()
    })
    try{
      expect(await access.run(()=>runKernelFiber(fake.fiber,{scheduler,signal:new AbortController().signal,expired:()=>false,takeWait}))).toBe(fake.result)
      expect(events).toEqual(['peer host task']);expect(takeWait).not.toHaveBeenCalled()
      expect(fake.events).toEqual(['step','take','dispose'])
      access.drain();expect(events).toEqual(['peer host task','guest completion'])
      expect(checkpoint).toHaveBeenCalledTimes(1)
    }finally{access.close();scheduler.close()}
  })

  it('cancels a fairness pause before resuming when its checkpoint aborts',async()=>{
    const scheduler=new TaskScheduler(),controller=new AbortController(),fake=fakeFiber(0),takeWait=vi.fn()
    const step=fake.fiber.step
    fake.fiber.step=vi.fn().mockImplementationOnce(()=>3).mockImplementation(step)
    vi.spyOn(scheduler,'checkpoint').mockImplementation(async()=>{controller.abort()})
    try{
      expect(await runKernelFiber(fake.fiber,{scheduler,signal:controller.signal,expired:()=>false,takeWait})).toBe(fake.result)
      expect(fake.events).toEqual(['cancel','step','take','dispose']);expect(takeWait).not.toHaveBeenCalled()
    }finally{scheduler.close()}
  })

  it('does not read the timing clock without a step observer',async()=>{
    const scheduler=new TaskScheduler(),fake=fakeFiber(0),clock=vi.spyOn(performance,'now')
    try{
      expect(await runKernelFiber(fake.fiber,{scheduler,signal:new AbortController().signal,expired:()=>false,takeWait:()=>0})).toBe(fake.result)
      expect(clock).not.toHaveBeenCalled()
    }finally{clock.mockRestore();scheduler.close()}
  })

  it('reports each step after it returns without including waits or result transfer',async()=>{
    const scheduler=new TaskScheduler(),fake=fakeFiber(1),observed:Array<{duration:number;status:number|undefined;event:string|undefined}>=[]
    try{
      expect(await runKernelFiber(fake.fiber,{scheduler,signal:new AbortController().signal,expired:()=>false,takeWait:()=>1,onStep(duration,status){observed.push({duration,status,event:fake.events.at(-1)})}})).toBe(fake.result)
      expect(observed.map(item=>item.status)).toEqual([1,2])
      expect(observed.every(item=>item.duration>=0&&Number.isFinite(item.duration)&&item.event==='step')).toBe(true)
      expect(fake.events).toEqual(['step','deliver:0','step','take','dispose'])
    }finally{scheduler.close()}
  })

  it('reports thrown steps and cleanup steps without allowing observer errors to replace execution',async()=>{
    const scheduler=new TaskScheduler(),fake=fakeFiber(0),primary=Error('Primary failure'),statuses:Array<number|undefined>=[]
    const step=fake.fiber.step
    fake.fiber.step=vi.fn().mockImplementationOnce(()=>{throw primary}).mockImplementation(step)
    try{
      await expect(runKernelFiber(fake.fiber,{scheduler,signal:new AbortController().signal,expired:()=>false,takeWait:()=>0,onStep(duration,status){expect(duration).toBeGreaterThanOrEqual(0);statuses.push(status);throw Error('Observer failure')}})).rejects.toBe(primary)
      expect(statuses).toEqual([undefined,2])
      expect(fake.events).toEqual(['cancel','step','take','dispose'])
      expect(fake.resultDispose).toHaveBeenCalledTimes(1)
    }finally{scheduler.close()}
  })

  it('preserves the primary step failure and cleanup failures while attempting disposal',async()=>{
    const scheduler=new TaskScheduler(),fake=fakeFiber(0)
    const primary=Error('Primary interpreter failure'),unwind=Error('Unwind failed'),disposal=Error('Fiber must finish and transfer its result before disposal')
    primary.stack='WebAssembly.RuntimeError: Primary interpreter failure\n    at wasm-function[123]:0x456'
    fake.fiber.step=vi.fn().mockImplementationOnce(()=>{throw primary}).mockImplementationOnce(()=>{throw unwind})
    fake.fiber.dispose=vi.fn(()=>{throw disposal})
    try{
      const error=await runKernelFiber(fake.fiber,{scheduler,signal:new AbortController().signal,expired:()=>false,takeWait:()=>0}).catch(error=>error)
      expect(error).toBeInstanceOf(AggregateError)
      expect(error.errors).toEqual([primary,unwind,disposal]);expect(error.cause).toBe(primary)
      for(const failure of [primary,unwind,disposal])expect(error.message).toContain(failure.message)
      for(const failure of [primary,unwind,disposal])expect(error.stack).toContain(failure.stack)
      expect(error.stack).toContain('wasm-function[123]:0x456')
      expect(fake.events).toEqual(['cancel'])
      expect(fake.fiber.step).toHaveBeenCalledTimes(2)
      expect(fake.fiber.dispose).toHaveBeenCalledTimes(1)
      expect(fake.resultDispose).not.toHaveBeenCalled()
    }finally{scheduler.close()}
  })

  it('keeps a primary step failure unchanged when cancellation cleanup succeeds',async()=>{
    const scheduler=new TaskScheduler(),fake=fakeFiber(0),primary=Error('Primary failure')
    const step=fake.fiber.step
    fake.fiber.step=vi.fn().mockImplementationOnce(()=>{throw primary}).mockImplementation(step)
    try{
      await expect(runKernelFiber(fake.fiber,{scheduler,signal:new AbortController().signal,expired:()=>false,takeWait:()=>0})).rejects.toBe(primary)
      expect(fake.events).toEqual(['cancel','step','take','dispose'])
      expect(fake.resultDispose).toHaveBeenCalledTimes(1)
    }finally{scheduler.close()}
  })

  it('atomic waits ignore unrelated wakes and only deliver timeout after the deadline',async()=>{
    const scheduler=new TaskScheduler(),fake=fakeFiber(1),takeWait=vi.fn(()=>0)
    fake.fiber.atomicWait=()=>30;fake.fiber.atomicReady=()=>false
    const running=runKernelFiber(fake.fiber,{scheduler,signal:new AbortController().signal,expired:()=>false,takeWait})
    scheduler.wake()
    try{
      await new Promise(resolve=>setTimeout(resolve,5))
      expect(fake.events).toEqual(['step'])
      expect(await running).toBe(fake.result)
      expect(fake.events).toEqual(['step','deliver:2','step','take','dispose'])
      expect(takeWait).not.toHaveBeenCalled()
    }finally{scheduler.close()}
  })

  it('a peer engine step wakes a notified atomic waiter without a host result',async()=>{
    const scheduler=new TaskScheduler(),peerScheduler=new TaskScheduler(),fake=fakeFiber(1),peer=fakeFiber(0)
    fake.fiber.atomicWait=()=>Infinity;fake.fiber.atomicReady=()=>fake.events.includes('deliver:0')
    const options={signal:new AbortController().signal,expired:()=>false,takeWait:()=>{throw Error('Not a delay')}}
    const waiting=runKernelFiber(fake.fiber,{...options,scheduler})
    // Model native notification during the peer step, before its host returns.
    const peerStep=peer.fiber.step
    peer.fiber.step=()=>{fake.fiber.deliver(0);return peerStep()}
    try{
      await runKernelFiber(peer.fiber,{...options,scheduler:peerScheduler})
      expect(await waiting).toBe(fake.result)
      expect(fake.events.filter(event=>event.startsWith('deliver'))).toEqual(['deliver:0'])
    }finally{scheduler.close();peerScheduler.close()}
  })

  it('an infinite atomic wait unwinds on abort without a timeout result',async()=>{
    const scheduler=new TaskScheduler(),fake=fakeFiber(1),controller=new AbortController()
    fake.fiber.atomicWait=()=>Infinity;fake.fiber.atomicReady=()=>false
    const waiting=runKernelFiber(fake.fiber,{scheduler,signal:controller.signal,expired:()=>false,takeWait:()=>0})
    controller.abort()
    try{
      expect(await waiting).toBe(fake.result)
      expect(fake.events.filter(event=>event.startsWith('deliver'))).toEqual([])
      expect(fake.events.at(-1)).toBe('dispose')
    }finally{scheduler.close()}
  })

  it('does not mistake an unrelated scheduler wake for a host result',async()=>{
    const scheduler=new TaskScheduler(),controller=new AbortController(),fake=fakeFiber(1)
    let wakes=0
    const takeWait=vi.fn(()=>40)
    const running=runKernelFiber(fake.fiber,{scheduler,signal:controller.signal,expired:()=>false,takeWait})
    const unrelated=setTimeout(()=>{wakes++;scheduler.wake()},0)
    try{
      await new Promise(resolve=>setTimeout(resolve,8))
      expect(wakes).toBe(1)
      expect(fake.events).toEqual(['step'])
      expect(await running).toBe(fake.result)
      expect(fake.events).toEqual(['step','deliver:0','step','take','dispose'])
      expect(takeWait).toHaveBeenCalledTimes(1)
      expect(fake.resultDispose).not.toHaveBeenCalled()
    }finally{clearTimeout(unrelated);scheduler.close()}
  })

  it('handles repeated waits and transfers the final result once',async()=>{
    const scheduler=new TaskScheduler(),fake=fakeFiber(3),takeWait=vi.fn(()=>1)
    try{
      const result=await runKernelFiber(fake.fiber,{scheduler,signal:new AbortController().signal,expired:()=>false,takeWait})
      expect(result).toBe(fake.result)
      expect(takeWait).toHaveBeenCalledTimes(3)
      expect(fake.events.filter(event=>event==='deliver:0')).toHaveLength(3)
      expect(fake.events.filter(event=>event==='take')).toHaveLength(1)
      expect(fake.events.at(-1)).toBe('dispose')
      expect(fake.resultDispose).not.toHaveBeenCalled()
    }finally{scheduler.close()}
  })

  it('aborts a parked fiber, unwinds it and returns its cancellation result',async()=>{
    const scheduler=new TaskScheduler(),fake=fakeFiber(1),controller=new AbortController()
    const running=runKernelFiber(fake.fiber,{scheduler,signal:controller.signal,expired:()=>false,takeWait:()=>1000})
    controller.abort()
    try{
      expect(await running).toBe(fake.result)
      expect(fake.events).toEqual(['step','cancel','step','take','dispose'])
      expect(fake.resultDispose).not.toHaveBeenCalled()
    }finally{scheduler.close()}
  })

  it('cleans up a parked fiber when its request source throws',async()=>{
    const scheduler=new TaskScheduler(),fake=fakeFiber(1),failure=Error('Missing wait request')
    try{
      await expect(runKernelFiber(fake.fiber,{scheduler,signal:new AbortController().signal,expired:()=>false,takeWait:()=>{throw failure}})).rejects.toBe(failure)
      expect(fake.events).toEqual(['step','cancel','step','take','dispose'])
      expect(fake.resultDispose).toHaveBeenCalledTimes(1)
    }finally{scheduler.close()}
  })

  it('wakes at the execution deadline before a longer requested wait finishes',async()=>{
    const scheduler=new TaskScheduler(),fake=fakeFiber(1)
    const started=performance.now(),deadline=started+10
    try{
      expect(await runKernelFiber(fake.fiber,{
        scheduler,signal:new AbortController().signal,
        expired:()=>performance.now()>=deadline,
        waitTimeout:()=>Math.max(1,deadline-performance.now()),
        takeWait:()=>1000,
      })).toBe(fake.result)
      expect(performance.now()-started).toBeLessThan(250)
      expect(fake.events).toEqual(['step','cancel','step','take','dispose'])
      expect(fake.resultDispose).not.toHaveBeenCalled()
    }finally{scheduler.close()}
  })

  it('does not start guest work when cancellation precedes the first step',async()=>{
    const scheduler=new TaskScheduler(),fake=fakeFiber(1),controller=new AbortController(),takeWait=vi.fn(()=>1)
    controller.abort()
    try{
      await runKernelFiber(fake.fiber,{scheduler,signal:controller.signal,expired:()=>false,takeWait})
      expect(fake.events).toEqual(['cancel','step','take','dispose'])
      expect(takeWait).not.toHaveBeenCalled()
    }finally{scheduler.close()}
  })

  it('transfers an immediately completed result without a wait',async()=>{
    const scheduler=new TaskScheduler(),fake=fakeFiber(0),takeWait=vi.fn(()=>1)
    try{
      expect(await runKernelFiber(fake.fiber,{scheduler,signal:new AbortController().signal,expired:()=>false,takeWait})).toBe(fake.result)
      expect(fake.events).toEqual(['step','take','dispose'])
      expect(takeWait).not.toHaveBeenCalled()
    }finally{scheduler.close()}
  })
})
