export async function runAtomicWait(engine){
  const check=(condition,label)=>{if(!condition)throw Error(label)}
  const tasks=new Set(),runtimes=[]
  const create=()=>{const runtime=engine.newRuntime();runtime.setMemoryLimit(16*1024*1024);runtime.setMaxStackSize(256*1024);runtimes.push(runtime);return runtime.newContext()}
  const a=create(),b=create(),peer=create(),contexts=[a,b,peer]
  const unwrap=(context,result)=>{if(result.error){const error=context.dump(result.error);result.dispose();throw Error(JSON.stringify(error))}return result.value}
  const evaluate=(context,source)=>unwrap(context,context.evalCode(source))
  const stats=()=>{const value=unwrap(peer,peer.sharedStorageStats());try{return peer.dump(value)}finally{value.dispose()}}
  const start=(context,source)=>{const fiber=context.startFiberEval(source,'atomic-wait.js',0);tasks.add(fiber);return fiber}
  const finish=(context,fiber,expected)=>{
    check(fiber.status()===2,'Fiber finished')
    const result=fiber.takeResult()
    try{
      if(expected==='cancelled'){check(Boolean(result.error),'Cancellation is an exception');check(context.dump(result.error).message.includes('cancelled'),'Cancellation reason')}
      else{const value=unwrap(context,result);try{check(context.getString(value)===expected,'Expected '+expected)}finally{value.dispose()}}
    }finally{if(expected==='cancelled')result.dispose();fiber.dispose();tasks.delete(fiber)}
  }
  const notify=source=>{const value=evaluate(peer,source);try{return peer.getNumber(value)}finally{value.dispose()}}
  let closed=false,cases=0
  try{
    const initial=stats(),buffer=evaluate(peer,'new SharedArrayBuffer(32)')
    peer.setProp(peer.global,'buffer',buffer)
    for(const context of [a,b]){const alias=unwrap(context,context.cloneSharedBufferFrom(peer,buffer));context.setProp(context.global,'buffer',alias);alias.dispose()}
    const alias=unwrap(peer,peer.cloneSharedBufferFrom(peer,buffer));peer.setProp(peer.global,'alias',alias);alias.dispose();buffer.dispose()
    const baseline=stats().references
    for(const [Type,expected] of [['Int32Array','0'],['BigInt64Array','0n']]){
      for(const [value,timeout,result] of [[Type==='Int32Array'?'1':'1n','Infinity','not-equal'],[expected,'0','timed-out']]){
        const fiber=start(a,`Atomics.wait(new ${Type}(buffer),0,${value},${timeout})`)
        check(fiber.step()===2,'Immediate wait completes');finish(a,fiber,result);cases++
      }
      const fiber=start(a,`Atomics.wait(new ${Type}(buffer),0,${expected},5)`)
      check(fiber.step()===1&&fiber.atomicWait()===5,'Finite wait parks with timeout')
      check(stats().references===baseline+1,'Wait owns storage reference')
      check(!fiber.deliver(0),'Host cannot fabricate notification')
      await new Promise(resolve=>setTimeout(resolve,8))
      check(fiber.deliver(2)&&fiber.step()===2,'Host timeout resumes wait')
      finish(a,fiber,'timed-out');check(stats().references===baseline,'Timeout releases storage');cases++
      const notified=start(a,`Atomics.wait(new ${Type}(buffer),0,${expected},Infinity)`)
      check(notified.step()===1&&notified.atomicWait()===Infinity,'Infinite wait parks')
      check(notify(`Atomics.notify(new ${Type}(alias),1,1)`)===0,'Wrong offset does not notify')
      check(notify(`Atomics.notify(new ${Type}(alias),0,1)`)===1,'Alias notification matches')
      check(notified.atomicReady(),'Notification marks ready without resuming')
      check(!notified.deliver(2),'Stale timeout cannot overwrite notification')
      check(notified.step()===2,'Notification resumes');finish(a,notified,'ok');cases++
    }
    const first=start(a,'Atomics.wait(new Int32Array(buffer),0,0)'),second=start(b,'Atomics.wait(new Int32Array(buffer),0,0)')
    check(first.step()===1&&second.step()===1,'Two waiters park')
    check(stats().references===baseline+2,'Both waiters retain storage')
    check(notify('Atomics.notify(new Int32Array(buffer),0,0)')===0,'Zero count wakes nobody')
    check(notify('Atomics.notify(new Int32Array(buffer),0,1)')===1,'Count limits notification')
    check(first.atomicReady()&&!second.atomicReady(),'Notification follows registration order')
    check(first.step()===2,'First resumes');finish(a,first,'ok')
    check(notify('Atomics.notify(new BigInt64Array(alias),0)')===1,'Notification key is byte location, not view width')
    check(second.step()===2,'Second resumes');finish(b,second,'ok');cases++
    const cancelled=start(a,'Atomics.wait(new Int32Array(buffer),0,0)')
    check(cancelled.step()===1&&cancelled.cancel(),'Cancel parked wait')
    check(notify('Atomics.notify(new Int32Array(buffer),0)')===0,'Cancelled waiter is not notified')
    check(cancelled.step()===2,'Cancellation unwinds');finish(a,cancelled,'cancelled');cases++
    check(stats().references===baseline,'All waiter references released')
    for(const context of [a,b])context.dispose()
    for(const runtime of runtimes.slice(0,2))runtime.dispose()
    evaluate(peer,'delete globalThis.buffer;delete globalThis.alias').dispose()
    const final=stats();check(final.bytes===initial.bytes&&final.allocations===initial.allocations&&final.references===initial.references,'Storage returns to baseline')
    peer.dispose();runtimes[2].dispose();closed=true
    return {cases,int32:true,bigint64:true,finiteTimeout:true,fifo:true,aliasOffset:true,cancellation:true,staleTimeout:true,hostSuccessRejected:true,finalBytes:final.bytes,finalReferences:final.references}
  }finally{
    if(!closed){
      for(const fiber of tasks){fiber.cancel();fiber.step();if(fiber.status()===2){fiber.takeResult().dispose();fiber.dispose()}}
      for(const context of contexts)if(context.alive)context.dispose()
      for(const runtime of runtimes)if(runtime.alive)runtime.dispose()
    }
  }
}
