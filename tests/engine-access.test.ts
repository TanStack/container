import {describe,it,expect} from 'vitest'
import {EngineAccess} from '../src/sandbox/engine-access'

describe('engine access during suspension',()=>{
  it('counts completion sources without changing queue order or exposing mutable state',()=>{
    const access=new EngineAccess(),seen:number[]=[]
    access.enqueue(()=>seen.push(1),undefined,'process-event')
    access.enqueue(()=>seen.push(2),4,'worker-message')
    access.enqueue(()=>seen.push(3),undefined,'process-event')
    access.enqueue(()=>seen.push(4))
    const counts=access.pendingSources()
    expect(counts).toEqual({'process-event':2,'worker-message':1,other:1})
    counts['process-event']=99
    expect(access.pendingSources()['process-event']).toBe(2)
    access.drain(1);expect(access.pendingSources()).toEqual({'process-event':1,'worker-message':1,other:1})
    access.drain();expect(seen).toEqual([1,2,3,4]);expect(access.pendingSources()).toEqual({})
    access.close();expect(access.pendingSources()).toEqual({})
  })
  it('summarizes pending endpoint groups through a poll boundary without changing the queue',async()=>{
    const access=new EngineAccess(),seen:string[]=[]
    access.enqueue(()=>seen.push('file-before'))
    access.enqueue(()=>seen.push('worker-7-before'),7)
    access.enqueue(()=>seen.push('worker-2-before'),2)
    const boundary=access.boundary
    access.enqueue(()=>seen.push('worker-7-after'),7)
    access.enqueue(()=>seen.push('file-after'))
    let resume!:()=>void
    const running=access.run(()=>new Promise<void>(resolve=>{resume=resolve}))
    const expected={total:5,throughBoundary:3,nonWorker:2,workerEndpoints:2,workers:[{endpoint:7,pending:2,throughBoundary:1},{endpoint:2,pending:1,throughBoundary:1}],truncated:0}
    expect(access.busy).toBe(true)
    const snapshot=access.pendingSnapshot(boundary)
    expect(snapshot).toEqual(expected)
    expect(access.pendingSnapshot()).toEqual({...expected,throughBoundary:5,workers:[{endpoint:7,pending:2,throughBoundary:2},{endpoint:2,pending:1,throughBoundary:1}]})
    snapshot.workers[0]!.pending=999;snapshot.workers.push({endpoint:99,pending:1,throughBoundary:1})
    expect(access.pendingSnapshot(boundary)).toEqual(expected)
    expect(access.pending).toBe(5);expect(access.boundary).toBe(5);expect(seen).toEqual([])
    resume();await running
    expect(access.drain()).toBe(5)
    expect(seen).toEqual(['file-before','worker-7-before','worker-2-before','worker-7-after','file-after'])
    access.enqueue(()=>seen.push('discarded'),7);access.close()
    expect(access.pendingSnapshot()).toEqual({total:0,throughBoundary:0,nonWorker:0,workerEndpoints:0,workers:[],truncated:0})
    expect(seen).not.toContain('discarded')
  })
  it('bounds endpoint detail at 32 groups while preserving totals and drain order',()=>{
    const access=new EngineAccess(64),seen:number[]=[]
    const endpoints=Array.from({length:33},(_,i)=>100-i)
    for(const endpoint of endpoints)access.enqueue(()=>seen.push(endpoint),endpoint)
    const boundary=access.boundary
    access.enqueue(()=>seen.push(100),100)
    access.enqueue(()=>seen.push(68),68)
    access.enqueue(()=>seen.push(-1))
    const snapshot=access.pendingSnapshot(boundary)
    expect(snapshot).toEqual({total:36,throughBoundary:33,nonWorker:1,workerEndpoints:33,truncated:1,workers:endpoints.slice(0,32).map(endpoint=>({endpoint,pending:endpoint===100?2:1,throughBoundary:1}))})
    expect(access.pendingSnapshot().throughBoundary).toBe(36)
    expect(access.pending).toBe(36);expect(access.pendingThrough(boundary)).toBe(33)
    expect(access.nextWorkerEndpoint).toBe(100);expect(seen).toEqual([])
    expect(access.drain()).toBe(36)
    expect(seen).toEqual([...endpoints,100,68,-1]);access.close()
  })
  it('selects an active port without consuming another port or losing queue ages',()=>{
    let now=0;const access=new EngineAccess(8,()=>now),seen:string[]=[]
    access.enqueue(()=>seen.push('file'));now=1
    access.enqueue(()=>seen.push('other'),2);now=2
    access.enqueue(()=>seen.push('active'),1);now=5
    expect(access.drain(1,1)).toBe(1);expect(seen).toEqual(['active'])
    expect(access.snapshot()?.totalWaitMs).toBe(3)
    expect(access.snapshot()?.oldestPendingMs).toBe(5)
    expect(access.drain(1,1)).toBe(0);expect(access.pending).toBe(2)
    access.drain();expect(seen).toEqual(['active','file','other']);access.close()
  })
  it('keeps the initial poll boundary when an active port drains newer arrivals',()=>{
    const access=new EngineAccess()
    access.enqueue(()=>{},2)
    const boundary=access.boundary
    access.enqueue(()=>{},1)
    expect(access.pendingThrough(boundary)).toBe(1)
    access.drain(1,1)
    expect(access.pendingThrough(boundary)).toBe(1)
    access.drain(1,2)
    expect(access.pendingThrough(boundary)).toBe(0);access.close()
  })
  it('does not drain newly enqueued matching callbacks in the same drain call',()=>{
    const access=new EngineAccess(),seen:number[]=[]
    access.enqueue(()=>{seen.push(1);access.enqueue(()=>seen.push(3),1)},1)
    access.enqueue(()=>seen.push(2),2)
    expect(access.drain(8,1)).toBe(1);expect(seen).toEqual([1])
    access.drain();expect(seen).toEqual([1,2,3]);access.close()
  })
  it('reports passive queue wait metrics with an opt-in clock',()=>{
    let now=10
    const access=new EngineAccess(2,()=>now),seen:number[]=[]
    access.enqueue(()=>{seen.push(1);access.enqueue(()=>seen.push(3))})
    now=12;access.enqueue(()=>seen.push(2))
    expect(()=>access.enqueue(()=>{})).toThrow('queue full')
    now=20;expect(access.snapshot()).toEqual({enqueued:2,drained:0,maxPending:2,totalWaitMs:0,maxWaitMs:0,oldestPendingMs:10})
    access.drain(1)
    expect(seen).toEqual([1]);expect(access.snapshot()).toEqual({enqueued:3,drained:1,maxPending:2,totalWaitMs:10,maxWaitMs:10,oldestPendingMs:8})
    now=25;access.drain();expect(seen).toEqual([1,2,3])
    expect(access.snapshot()).toEqual({enqueued:3,drained:3,maxPending:2,totalWaitMs:28,maxWaitMs:13,oldestPendingMs:0})
    access.close();expect(access.snapshot()?.drained).toBe(3)
  })
  it('counts throwing callbacks once and clears pending ages on close',()=>{
    let now=0
    const access=new EngineAccess(2,()=>now),failure=Error('callback failed')
    access.enqueue(()=>{throw failure});now=2;access.enqueue(()=>{})
    now=5;expect(()=>access.drain()).toThrow(failure)
    expect(access.pending).toBe(1)
    expect(access.snapshot()).toEqual({enqueued:2,drained:1,maxPending:2,totalWaitMs:5,maxWaitMs:5,oldestPendingMs:3})
    access.close();expect(access.snapshot()).toEqual({enqueued:2,drained:1,maxPending:2,totalWaitMs:5,maxWaitMs:5,oldestPendingMs:0})
    const unmeasured=new EngineAccess();unmeasured.enqueue(()=>{});unmeasured.drain();expect(unmeasured.snapshot()).toBeUndefined()
  })
  it('can dispatch one host task without merging the next callback',()=>{
    const access=new EngineAccess(),seen:number[]=[]
    access.enqueue(()=>seen.push(1));access.enqueue(()=>seen.push(2))
    access.drain(1);expect(seen).toEqual([1]);expect(access.pending).toBe(1)
    access.drain(1);expect(seen).toEqual([1,2]);access.close()
  })
  it('defers completions and rejects reentry and disposal until execution returns',async()=>{
    const access=new EngineAccess(),seen:number[]=[]
    let resume!:()=>void
    const running=access.run(()=>new Promise<void>(resolve=>{resume=resolve}))
    access.enqueue(()=>seen.push(1));access.enqueue(()=>seen.push(2))
    expect(seen).toEqual([])
    await expect(access.run(()=>42)).rejects.toThrow('already executing')
    expect(()=>access.drain()).toThrow('executing')
    expect(()=>access.close()).toThrow('executing')
    resume();await running;access.drain()
    expect(seen).toEqual([1,2]);access.close()
  })
  it('bounds queued work and gives callback arrivals a later turn',()=>{
    const access=new EngineAccess(2),seen:number[]=[]
    access.enqueue(()=>{seen.push(1);access.enqueue(()=>seen.push(3))})
    access.enqueue(()=>seen.push(2))
    expect(()=>access.enqueue(()=>{})).toThrow('queue full')
    access.drain();expect(seen).toEqual([1,2]);expect(access.pending).toBe(1)
    access.drain();expect(seen).toEqual([1,2,3]);access.close()
  })
  it('releases execution ownership on failure and preserves unprocessed completions',async()=>{
    const access=new EngineAccess()
    await expect(access.run(()=>{throw Error('guest failed')})).rejects.toThrow('guest failed')
    expect(access.busy).toBe(false)
    access.enqueue(()=>{throw Error('completion failed')});access.enqueue(()=>{})
    expect(()=>access.drain()).toThrow('completion failed');expect(access.pending).toBe(1)
    access.close();expect(access.pending).toBe(0)
    await expect(access.run(()=>42)).rejects.toThrow('closed')
  })
  it('rejects recursive drains and closure inside a completion',()=>{
    const access=new EngineAccess()
    access.enqueue(()=>{
      expect(()=>access.drain()).toThrow('executing')
      expect(()=>access.close()).toThrow('executing')
    })
    access.drain();access.close()
  })
})
