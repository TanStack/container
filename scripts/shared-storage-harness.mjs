export async function runSharedStorage(engine){
  const check=(value,label)=>{if(!value)throw Error(label)}
  const create=()=>{const runtime=engine.newRuntime();runtime.setMemoryLimit(8*1024*1024);return {runtime,context:runtime.newContext()}}
  const a=create(),b=create(),observer=create()
  const unwrap=(ctx,result)=>{if(result.error){const error=ctx.dump(result.error);result.dispose();throw Error(JSON.stringify(error))}return result.value}
  const evaluate=(ctx,source)=>unwrap(ctx,ctx.evalCode(source))
  const stats=()=>{const value=unwrap(observer.context,observer.context.sharedStorageStats());try{return observer.context.dump(value)}finally{value.dispose()}}
  let aClosed=false,bClosed=false
  try{
    check(stats().bytes===0&&stats().allocations===0&&stats().wrappers===0,'Empty initial storage registry')
    const initialFreed=stats().freed
    const original=evaluate(a.context,'new SharedArrayBuffer(65536)')
    a.context.setProp(a.context.global,'buffer',original)
    evaluate(a.context,'new Int32Array(buffer)[0]=41').dispose()
    const adopted=unwrap(b.context,b.context.cloneSharedBufferFrom(a.context,original))
    const alias=unwrap(b.context,b.context.cloneSharedBufferFrom(a.context,original))
    check(stats().references===3,'Each SAB wrapper owns exactly one reference')
    check(stats().wrappers===3,'Creator and two cloned SAB objects register three wrappers')
    b.context.setProp(b.context.global,'buffer',adopted);b.context.setProp(b.context.global,'alias',alias)
    adopted.dispose();alias.dispose()
    const first=evaluate(b.context,'Atomics.add(new Int32Array(buffer),0,1)')
    check(b.context.getNumber(first)===41,'Shared atomic RMW sees creator write');first.dispose()
    const visible=evaluate(a.context,'new Int32Array(buffer)[0]')
    check(a.context.getNumber(visible)===42,'Creator sees peer write without copying');visible.dispose()
    original.dispose();a.context.dispose();a.runtime.dispose();aClosed=true
    check(stats().bytes===65536&&stats().allocations===1&&stats().references===2,'Creator teardown preserves shared backing')
    check(stats().wrappers===2,'Creator teardown removes only its SAB wrapper')
    const survivor=evaluate(b.context,'Atomics.add(new Int32Array(alias),0,1);new Int32Array(buffer)[0]')
    check(b.context.getNumber(survivor)===43,'Survivor aliases stay live');survivor.dispose()
    b.context.dispose();b.runtime.dispose();bClosed=true
    check(stats().bytes===0&&stats().allocations===0&&stats().references===0&&stats().freed===initialFreed+1,'Final release refunds group storage exactly once')
    check(stats().wrappers===0,'Final runtime disposal unregisters every SAB wrapper')
    const tooLarge=observer.context.evalCode('new SharedArrayBuffer(16777217)')
    check(Boolean(tooLarge.error),'Group allocation quota rejects oversize allocation');tooLarge.dispose()
    check(stats().bytes===0&&stats().allocations===0,'Quota rejection leaks no reservation')
    evaluate(observer.context,'globalThis.buffers=Array.from({length:256},()=>new SharedArrayBuffer(1));undefined').dispose()
    check(stats().allocations===256&&stats().bytes===256,'Small buffers consume allocation slots')
    const tooMany=observer.context.evalCode('new SharedArrayBuffer(1)')
    check(Boolean(tooMany.error),'Allocation count quota enforced');tooMany.dispose()
    evaluate(observer.context,'delete globalThis.buffers').dispose()
    check(stats().bytes===0&&stats().allocations===0&&stats().references===0,'Allocation slots refunded')
    for(const cancelled of [false,true]){
      const sender=create(),receiver=create()
      let senderClosed=false,lease
      try{
        const buffer=evaluate(sender.context,'new SharedArrayBuffer(16)')
        sender.context.setProp(sender.context.global,'queued',buffer)
        evaluate(sender.context,'new Int32Array(queued)[0]=73').dispose()
        lease=sender.context.retainSharedBuffer(buffer)
        buffer.dispose();sender.context.dispose();sender.runtime.dispose();senderClosed=true
        check(lease.alive&&stats().leases===1&&stats().bytes===16&&stats().references===1,'Queued lease alone retains creator storage')
        check(stats().wrappers===0,'Queued lease is not a live QuickJS SAB wrapper')
        if(cancelled){
          lease.dispose();lease.dispose()
          check(!lease.alive&&stats().bytes===0&&stats().leases===0,'Cancelled delivery releases storage once')
        }else{
          const delivered=unwrap(receiver.context,lease.adopt(receiver.context))
          receiver.context.setProp(receiver.context.global,'delivered',delivered);delivered.dispose()
          check(!lease.alive&&stats().leases===0&&stats().references===1,'Adoption transfers lease into one receiver reference')
          check(stats().wrappers===1,'Queued buffer adoption registers one receiver SAB wrapper')
          const value=evaluate(receiver.context,'Atomics.add(new Int32Array(delivered),0,1)')
          check(receiver.context.getNumber(value)===73,'Delivered buffer retains creator bytes');value.dispose()
          let duplicateRejected=false
          try{lease.adopt(receiver.context)}catch{duplicateRejected=true}
          check(duplicateRejected,'Consumed lease cannot be adopted twice')
          lease.dispose()
        }
      }finally{
        lease?.dispose()
        if(!senderClosed){sender.context.dispose();sender.runtime.dispose()}
        receiver.context.dispose();receiver.runtime.dispose()
      }
      check(stats().bytes===0&&stats().allocations===0&&stats().references===0&&stats().leases===0,'Queued delivery cleanup refunds all storage')
      check(stats().wrappers===0,'Queued delivery cleanup unregisters every SAB wrapper')
    }
    return {sharedWrites:true,atomicOldValue:41,survivingValue:43,creatorTeardown:true,finalBytes:stats().bytes,finalAllocations:stats().allocations,quotaRejection:true,allocationQuota:true,exactReferences:true,queuedCreatorExit:true,queuedAdoption:true,queuedCancellation:true}
  }finally{
    if(!aClosed){a.context.dispose();a.runtime.dispose()}
    if(!bClosed){b.context.dispose();b.runtime.dispose()}
    observer.context.dispose();observer.runtime.dispose()
  }
}
