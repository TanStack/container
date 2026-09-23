import {test,expect,vi} from 'vitest'
import {TaskScheduler,type TaskSchedulerSample} from '../src/sandbox/task-scheduler'

for(const ready of [true,false])test(`I/O wake preserves the task boundary (ready=${ready})`,async()=>{
  const scheduler=new TaskScheduler()
  try{
    let done=false
    const waiting=scheduler.wait(ready).then(()=>{done=true})
    scheduler.wake();scheduler.wake()
    await Promise.resolve();await Promise.resolve()
    expect(done).toBe(false)
    await waiting;expect(done).toBe(true)
  }finally{scheduler.close()}
})

test('ready work waits for a host task rather than a microtask',async()=>{
  const scheduler=new TaskScheduler()
  try{
    let done=false;const ready=scheduler.wait(true,1000).then(()=>{done=true})
    await Promise.resolve();expect(done).toBe(false)
    await ready;expect(done).toBe(true)
  }finally{scheduler.close()}
})

test('consecutive ready turns use message tasks without allocating timeout timers',async()=>{
  vi.useFakeTimers();const scheduler=new TaskScheduler()
  try{
    for(let index=0;index<16;index++){
      const waiting=scheduler.wait(true,15000)
      expect(vi.getTimerCount()).toBe(0)
      await waiting
      expect(vi.getTimerCount()).toBe(0)
    }
  }finally{scheduler.close();vi.useRealTimers()}
})

test('a stale posted task cannot wake a newer resource wait',async()=>{
  const scheduler=new TaskScheduler()
  try{
    const old=scheduler.wait(true,1000);scheduler.wake();await old
    let done=false;const next=scheduler.wait(false,1000).then(()=>{done=true})
    await new Promise(resolve=>setTimeout(resolve,20));expect(done).toBe(false)
    scheduler.wake();await next;expect(done).toBe(true)
  }finally{scheduler.close()}
})

test('idle waits have a deadline and wake clears their timer',async()=>{
  vi.useFakeTimers();const scheduler=new TaskScheduler()
  try{
    let done=false;const idle=scheduler.wait(false,30).then(()=>{done=true})
    await vi.advanceTimersByTimeAsync(29);expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1);await idle;expect(done).toBe(true)
    const early=scheduler.wait(false,30);scheduler.wake();await early
    expect(vi.getTimerCount()).toBe(0)
  }finally{scheduler.close();vi.useRealTimers()}
})

test('close releases waiters and refuses new work',async()=>{
  const scheduler=new TaskScheduler(),waiting=scheduler.wait(false,10000)
  scheduler.close();await waiting;scheduler.close()
  await expect(scheduler.wait(true,0)).rejects.toThrow('Scheduler closed')
})

test('an indefinite idle wait allocates no timer and still wakes and closes',async()=>{
  vi.useFakeTimers();const scheduler=new TaskScheduler()
  try{
    let done=false;const waiting=scheduler.wait(false).then(()=>{done=true})
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(120000);expect(done).toBe(false)
    scheduler.wake();await waiting;expect(done).toBe(true)
    const closing=scheduler.wait(false);scheduler.close();await closing
  }finally{scheduler.close();vi.useRealTimers()}
})

test('an exit checkpoint drains nested host microtasks and ignores early wakes',async()=>{
  const scheduler=new TaskScheduler(),events:string[]=[]
  try{
    const checkpoint=scheduler.checkpoint().then(()=>events.push('checkpoint'))
    void Promise.resolve().then(()=>{scheduler.wake();return Promise.resolve().then(()=>{scheduler.wake();events.push('settled')})})
    await checkpoint;expect(events).toEqual(['settled','checkpoint'])
    const closing=scheduler.checkpoint();scheduler.close();await closing
    await expect(scheduler.checkpoint()).rejects.toThrow('Scheduler closed')
  }finally{scheduler.close()}
})

test('observed peer tasks retain task boundaries and correlate globally ordered samples',async()=>{
  const samples:Array<TaskSchedulerSample&{lane:number}>=[],events:string[]=[]
  let now=0
  const schedulers=[0,1].map(lane=>new TaskScheduler(sample=>{samples.push({...sample,lane});sample.taskId=-1},()=>++now))
  try{
    const pending=schedulers.map((scheduler,lane)=>scheduler.checkpoint().then(()=>events.push('checkpoint:'+lane)))
    await Promise.resolve();expect(events).toEqual([])
    await Promise.all(pending)
    const waits=schedulers.map((scheduler,lane)=>scheduler.wait(true).then(()=>events.push('wait:'+lane)))
    schedulers.forEach(scheduler=>scheduler.wake())
    await Promise.resolve();expect(events).toHaveLength(2)
    await Promise.all(waits)
    expect(events).toHaveLength(4)
    const posts=samples.filter(sample=>sample.phase==='post'),dispatches=samples.filter(sample=>sample.phase==='dispatch')
    expect(posts).toHaveLength(4);expect(dispatches).toHaveLength(4)
    expect(posts.map(row=>row.postSequence)).toEqual([...posts.map(row=>row.postSequence)].sort((a,b)=>a-b))
    expect(new Set(posts.map(row=>row.postSequence)).size).toBe(4)
    expect(dispatches.map(row=>row.dispatchSequence)).toEqual([...dispatches.map(row=>row.dispatchSequence!)].sort((a,b)=>a-b))
    for(const post of posts){const dispatch=dispatches.find(row=>row.postSequence===post.postSequence)!;expect(dispatch).toMatchObject({lane:post.lane,taskId:post.taskId,kind:post.kind,postedAt:post.postedAt});expect(dispatch.dispatchAt).toBeGreaterThan(post.postedAt)}
    for(const lane of [0,1])expect(samples.filter(row=>row.phase==='dispatch'&&row.lane===lane).map(row=>row.kind)).toEqual(['checkpoint','wait'])
  }finally{schedulers.forEach(scheduler=>scheduler.close())}
})

test('throwing diagnostics cannot block dispatch and close does not invent a dispatch',async()=>{
  const broken=new TaskScheduler(()=>{throw Error('observer')})
  const clockFailure=new TaskScheduler(()=>{},()=>{throw Error('clock')})
  const samples:TaskSchedulerSample[]=[],closing=new TaskScheduler(row=>samples.push(row))
  try{
    await broken.checkpoint();await broken.wait(true)
    await clockFailure.checkpoint();await clockFailure.wait(true)
    const pending=closing.checkpoint();closing.close();await pending
    expect(samples.map(row=>row.phase)).toEqual(['post'])
  }finally{broken.close();clockFailure.close();closing.close()}
})
