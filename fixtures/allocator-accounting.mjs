export function probeAllocatorAccounting(engine){
  const runtime=engine.newRuntime(),context=runtime.newContext(),limit=2*1024*1024,rows=[]
  runtime.setMemoryLimit(limit);runtime.setMaxStackSize(512*1024)
  const deadline=Date.now()+5000;runtime.setInterruptHandler(()=>Date.now()>deadline)
  const evaluate=source=>{const value=context.unwrapResult(context.evalCode(source));try{return context.dump(value)}finally{value.dispose()}}
  try{
    const chunks=evaluate(`globalThis.buffers=[];let failed=false;try{for(let i=0;i<512;i++)buffers.push(new Uint8Array(16384))}catch(e){failed=true};({failed,payload:buffers.length*16384,count:buffers.length})`)
    rows.push({name:'aggregate typed-array allocations',...chunks,enforced:chunks.failed&&chunks.payload<limit})
    evaluate('buffers=null')
    const reclaimed=evaluate(`globalThis.buffers=Array.from({length:48},()=>new Uint8Array(16384));buffers.length`)
    rows.push({name:'freed allocation accounting recovers',count:reclaimed,enforced:reclaimed===48})
    const resized=evaluate(`globalThis.items=[];let resizeFailed=false;try{for(let i=0;i<200000;i++)items.push(i)}catch(e){resizeFailed=true};({failed:resizeFailed,length:items.length})`)
    rows.push({name:'reallocations count against retained buffers',...resized,enforced:resized.failed})
    evaluate('items=null;buffers=null')
    const answer=evaluate('40+2')
    rows.push({name:'runtime recovers after allocation rejection',value:answer,enforced:answer===42})
  }finally{context.dispose();runtime.dispose()}
  return {limit,rows,scope:'QuickJS allocator accounting, not total WASM or browser-process memory'}
}

export function probeContextAllocation(engine){
  const rows=[]
  for(let headroom=0;headroom<=131072;headroom+=128){
    const runtime=engine.newRuntime(),context=runtime.newContext()
    runtime.context=context
    runtime.setMemoryLimit(16*1024*1024);runtime.setMaxStackSize(512*1024)
    const factory=context.getProp(context.global,'__qjsCreateContext'),sandbox=context.newObject()
    try{
      const usage=runtime.computeMemoryUsage(),bytes=context.dump(usage).memory_used_size;usage.dispose()
      if(!Number.isSafeInteger(bytes)||bytes<=0)throw Error('Missing live-memory measurement')
      runtime.setMemoryLimit(bytes+headroom)
      const result=context.callFunction(factory,context.undefined,sandbox,context.true)
      runtime.setMemoryLimit(16*1024*1024)
      const failed=!!result.error,error=failed?context.dump(result.error):undefined
      result.dispose()
      const recovery=context.unwrapResult(context.evalCode('40+2'))
      const answer=context.getNumber(recovery);recovery.dispose()
      rows.push({headroom,estimatedLiveBytes:bytes,failed,error,recovery:answer})
      if(answer!==42)throw Error('Context allocation did not recover')
    }finally{
      runtime.setMemoryLimit(16*1024*1024)
      sandbox.dispose();factory.dispose();context.dispose();runtime.dispose()
    }
  }
  return rows
}
