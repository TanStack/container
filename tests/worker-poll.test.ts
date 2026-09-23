import {describe,it,expect} from 'vitest'
import {ProcessMessageQueue} from '../src/sandbox/process-message-queue'
import {WorkerPoll} from '../src/sandbox/worker-poll'

describe('worker poll snapshots',()=>{
  it('defers a newly observed ready port until the next poll snapshot',()=>{
    const values=new Map([[1,{token:0,closed:false}],[2,{token:1,closed:false}]])
    const poll=new WorkerPoll(endpoint=>values.get(endpoint)!)
    poll.observe(1);poll.begin();poll.observe(2)
    // Characterize current behavior, not a claim about native Node ordering.
    expect(poll.pending).toBe(false)
    expect(poll.diagnosticSnapshot([2])[0]).toMatchObject({observed:true,settled:0,eligible:false,limit:undefined})
    poll.begin();expect(poll.pending).toBe(true)
    poll.activate(2);expect(poll.active).toBe(2)
    poll.settled(2,1);expect(poll.pending).toBe(false)
  })
  it('reads stored diagnostic lifecycle state without refreshing or admitting ports',()=>{
    const values=new Map([[1,{token:0,closed:false}],[2,{token:1,closed:false}]]);let reads=0
    const poll=new WorkerPoll(endpoint=>{reads++;return values.get(endpoint)!},3)
    const diagnostic=()=>{const before=reads;const rows=poll.diagnosticSnapshot([1,2,99]);expect(reads).toBe(before);return rows}
    expect(diagnostic()[2]).toEqual({endpoint:99,observed:false,settled:undefined,limit:undefined,eligible:false,active:false})
    poll.observe(1);poll.observe(2)
    expect(diagnostic()[0]).toEqual({endpoint:1,observed:true,settled:0,limit:undefined,eligible:false,active:false})
    poll.begin()
    expect(diagnostic().slice(0,2)).toEqual([
      {endpoint:1,observed:true,settled:0,limit:undefined,eligible:true,active:false},
      {endpoint:2,observed:true,settled:0,limit:3,eligible:false,active:false},
    ])
    values.get(1)!.token=1
    expect(diagnostic()[0].eligible).toBe(true);expect(diagnostic()[0].limit).toBeUndefined()
    poll.activate(2)
    expect(diagnostic()[0]).toMatchObject({limit:3,eligible:false,active:false})
    expect(diagnostic()[1].active).toBe(true)
    poll.settled(2,1)
    // The diagnostic must preserve stale stored state until normal polling updates it.
    expect(diagnostic()[1]).toMatchObject({settled:1,limit:3,active:true})
    expect(poll.active).toBeUndefined()
    expect(diagnostic()[1]).toMatchObject({settled:1,limit:undefined,eligible:false,active:false})
    values.get(2)!.token=2
    expect(diagnostic()[1].limit).toBeUndefined()
    poll.begin();expect(diagnostic()[1]).toMatchObject({settled:1,limit:4,eligible:false,active:false})
  })
  it('caps diagnostic detail at the first 32 requested endpoints and returns copied records',()=>{
    let reads=0;const poll=new WorkerPoll(()=>{reads++;throw Error('diagnostics must not read channel state')})
    poll.observe(50);poll.settled(50,7)
    const endpoints=Object.freeze(Array.from({length:34},(_,i)=>50-i))
    const rows=poll.diagnosticSnapshot(endpoints)
    expect(rows).toHaveLength(32);expect(rows.map(row=>row.endpoint)).toEqual(endpoints.slice(0,32));expect(reads).toBe(0)
    rows[0]!.settled=999;rows[0]!.observed=false;rows.pop()
    const fresh=poll.diagnosticSnapshot(endpoints)
    expect(fresh).toHaveLength(32);expect(fresh[0]).toEqual({endpoint:50,observed:true,settled:7,limit:undefined,eligible:false,active:false});expect(reads).toBe(0)
    expect(poll.diagnosticSnapshot([])).toEqual([])
  })
  it('starts a port batch only on dispatch and keeps it until that port is empty',async()=>{
    const queues=new Map([[1,new ProcessMessageQueue()],[2,new ProcessMessageQueue()]])
    const poll=new WorkerPoll(endpoint=>queues.get(endpoint)!.pollSnapshot())
    for(const [endpoint,queue] of queues){poll.observe(endpoint);queue.send(new Uint8Array([1]));queue.send(new Uint8Array([2]))}
    poll.begin();expect(poll.pending).toBe(true);expect(poll.active).toBeUndefined()
    poll.activate(undefined);expect(poll.active).toBeUndefined()
    poll.activate(2);expect(poll.active).toBe(2)
    poll.activate(1);expect(poll.active).toBe(2)
    for(let index=0;index<2;index++){
      const delivery=(await queues.get(2)!.receiveLease())!
      poll.settled(2,delivery.token);queues.get(2)!.ackReceive(delivery.token)
    }
    expect(poll.active).toBeUndefined();poll.activate(1);expect(poll.active).toBe(1)
  })
  it('drains arrivals during callbacks but retires an endpoint as soon as it is empty',async()=>{
    const queue=new ProcessMessageQueue(),poll=new WorkerPoll(()=>queue.pollSnapshot())
    poll.observe(1)
    queue.send(new Uint8Array([1]));queue.send(new Uint8Array([2]))
    const first=(await queue.receiveLease())!
    poll.begin();expect(poll.pending).toBe(true)
    poll.settled(1,first.token);queue.ackReceive(first.token)
    expect(poll.pending).toBe(true)
    queue.send(new Uint8Array([3]))
    const second=(await queue.receiveLease())!
    poll.settled(1,second.token);queue.ackReceive(second.token)
    expect(poll.pending).toBe(true)
    const third=(await queue.receiveLease())!
    poll.settled(1,third.token);queue.ackReceive(third.token)
    expect(poll.pending).toBe(false)
    queue.send(new Uint8Array([4]));expect(poll.pending).toBe(false)
    poll.begin();expect(poll.pending).toBe(true)
  })
  it('bounds an active endpoint with a small test batch floor without changing queue capacity',async()=>{
    const queue=new ProcessMessageQueue(),poll=new WorkerPoll(()=>queue.pollSnapshot(),3)
    poll.observe(1);queue.send(new Uint8Array([1]));poll.begin()
    for(let index=0;index<3;index++){
      expect(poll.pending).toBe(true)
      const delivery=(await queue.receiveLease())!
      poll.settled(1,delivery.token);queue.ackReceive(delivery.token)
      queue.send(new Uint8Array([1]))
    }
    expect(poll.pending).toBe(false);expect(queue.maxMessages).toBe(256)
    poll.begin();expect(poll.pending).toBe(true)
  })
  it('does not wait for unstarted ports and drops closed or forgotten channels',()=>{
    const queue=new ProcessMessageQueue();let forgotten=false
    const poll=new WorkerPoll(()=>{if(forgotten)throw Error('ESRCH');return queue.pollSnapshot()})
    queue.send(new Uint8Array([1]));poll.begin();expect(poll.pending).toBe(false)
    poll.observe(1);poll.begin();expect(poll.pending).toBe(true)
    queue.close();expect(poll.pending).toBe(false)
    forgotten=true;poll.begin();expect(poll.pending).toBe(false)
  })
  it('drains the initial backlog when it exceeds the batch floor without extending that batch',async()=>{
    const queue=new ProcessMessageQueue(),poll=new WorkerPoll(()=>queue.pollSnapshot(),2)
    poll.observe(1)
    for(let index=0;index<4;index++)queue.send(new Uint8Array([index]))
    poll.begin()
    for(let index=0;index<4;index++){
      expect(poll.pending).toBe(true)
      const delivery=(await queue.receiveLease())!
      poll.settled(1,delivery.token);queue.ackReceive(delivery.token)
      queue.send(new Uint8Array([index+4]))
    }
    expect(poll.pending).toBe(false)
    poll.begin();expect(poll.pending).toBe(true)
  })
  it('admits a second port made ready during the current poll turn',async()=>{
    const queues=new Map([[1,new ProcessMessageQueue()],[2,new ProcessMessageQueue()]])
    const poll=new WorkerPoll(endpoint=>queues.get(endpoint)!.pollSnapshot())
    poll.observe(1);poll.observe(2)
    queues.get(1)!.send(new Uint8Array([1]));poll.begin()
    queues.get(2)!.send(new Uint8Array([2]))
    const delivery=(await queues.get(1)!.receiveLease())!
    poll.settled(1,delivery.token);queues.get(1)!.ackReceive(delivery.token)
    expect(poll.pending).toBe(true)
    const second=(await queues.get(2)!.receiveLease())!
    poll.settled(2,second.token);queues.get(2)!.ackReceive(second.token)
    expect(poll.pending).toBe(false)
    queues.get(2)!.send(new Uint8Array([3]))
    expect(poll.pending).toBe(false)
    poll.begin();expect(poll.pending).toBe(true)
  })
  it('preserves accepted messages after graceful end and releases resources only on ack',async()=>{
    let disposed=0
    const queue=new ProcessMessageQueue(),poll=new WorkerPoll(()=>queue.pollSnapshot())
    poll.observe(1);queue.send(new Uint8Array([1]),[{dispose(){disposed++}}]);queue.end()
    poll.begin();expect(poll.pending).toBe(true);expect(disposed).toBe(0)
    const delivery=(await queue.receiveLease())!
    poll.settled(1,delivery.token);expect(poll.pending).toBe(false);expect(disposed).toBe(0)
    queue.ackReceive(delivery.token);expect(disposed).toBe(1)
  })
})
