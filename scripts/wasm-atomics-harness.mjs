import {atomicCases} from './wasm-atomics-cases.mjs'

export async function runWasmAtomics(engine,bytes,plainBytes,bootstrap){
  const check=(condition,label)=>{if(!condition)throw Error(label)}
  const runtimes=[],contexts=[],tasks=new Set()
  const create=()=>{const rt=engine.newRuntime();rt.setMemoryLimit(16*1024*1024);rt.setMaxStackSize(256*1024);runtimes.push(rt);const ctx=rt.newContext();contexts.push(ctx);return ctx}
  const unwrap=(ctx,result)=>{if(result.error){const error=ctx.dump(result.error);result.dispose();throw Error(JSON.stringify(error))}return result.value}
  const evaluate=(ctx,source)=>unwrap(ctx,ctx.evalCode(source))
  const start=(ctx,source)=>{const task=ctx.startFiberEval(source,'wasm-atomics.js',0);tasks.add(task);return task}
  const take=(ctx,task,expectError=false)=>{
    check(task.status()===2,'Fiber must complete before result')
    const result=task.takeResult()
    try{
      if(expectError){check(!!result.error,'Expected cancellation exception');return true}
      if(result.error)throw Error(JSON.stringify(ctx.dump(result.error)))
      return ctx.dump(result.value)
    }finally{result.dispose();task.dispose();tasks.delete(task)}
  }
  const run=(ctx,source)=>{const task=start(ctx,source);check(task.step()===2,'Immediate fixture must not park');return take(ctx,task)}
  const a=create(),b=create(),observer=create()
  const stats=()=>{const handle=unwrap(observer,observer.sharedStorageStats());try{return observer.dump(handle)}finally{handle.dispose()}}
  try{
    for(const ctx of [a,b])evaluate(ctx,'globalThis.__webContainerHost={shared:{}};'+bootstrap).dispose()
    const cases=JSON.parse(run(a,`JSON.stringify((${atomicCases.toString()})(WebAssembly,new Uint8Array(${JSON.stringify(Array.from(bytes))}),new Uint8Array(${JSON.stringify(Array.from(plainBytes))})))`))
    evaluate(a,'globalThis.memory=new WebAssembly.Memory({initial:1,maximum:2,shared:true})').dispose()
    const source=evaluate(a,'__webContainerHost.shared.wasmMemory.unwrap(memory)'),lease=a.retainSharedWasmMemory(source)
    source.dispose()
    try{const target=unwrap(b,lease.adopt(b));b.setProp(b.global,'memoryHandle',target);target.dispose()}finally{lease.dispose()}
    evaluate(b,'globalThis.memory=__webContainerHost.shared.wasmMemory.wrap(memoryHandle)').dispose()
    for(const ctx of [a,b])evaluate(ctx,`globalThis.e=new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(${JSON.stringify(Array.from(bytes))})),{env:{memory}}).exports`).dispose()
    const interop=[]
    for(const width of [32,64])for(const waiting of ['wasm','js'])for(const notifying of ['wasm','js']){
      evaluate(a,'new BigInt64Array(memory.buffer)[0]=0n').dispose()
      const wait=waiting==='wasm'?`e.wait${width}(0,${width===64?'0n':'0'},-1n)`:`Atomics.wait(new ${width===64?'BigInt64Array':'Int32Array'}(memory.buffer),0,${width===64?'0n':'0'})`
      const task=start(a,wait)
      check(task.step()===1&&task.atomicWait()===Infinity,'Indefinite wait parks')
      const notify=notifying==='wasm'?'e.notify(0,0xffffffff)':'Atomics.notify(new Int32Array(memory.buffer),0,1)'
      check(run(b,notify)===1,'Peer notification wakes one waiter')
      check(task.atomicReady()&&task.step()===2,'Notified WASM/JS fiber resumes')
      check(take(a,task)===(waiting==='wasm'?0:'ok'),'Correct wake result')
      interop.push({width,waiting,notifying})
    }
    const timeout=start(a,'e.wait32(0,0,5000000n)')
    check(timeout.step()===1&&timeout.atomicWait()===5,'Nanoseconds converted to milliseconds')
    check(timeout.deliver(2)&&timeout.step()===2,'Scheduler timeout resumes wait')
    check(take(a,timeout)===2,'Timeout result')
    const growing=start(a,'e.wait64(0,0n,-1n)')
    check(growing.step()===1,'Park before growth')
    check(run(b,'memory.grow(1);e.i64_64_store(65536,73n);e.notify(0,1)')===1,'Grow and notify')
    check(growing.step()===2&&take(a,growing)===0,'Resume after shared growth')
    check(run(a,'e.i64_64_load(65536).toString()')==='73','Resumed instance sees new page')
    const cancelled=start(a,'e.wait32(0,0,-1n)')
    check(cancelled.step()===1&&cancelled.cancel()&&cancelled.step()===2,'Cancel suspended WASM wait')
    take(a,cancelled,true)
    check(run(a,'e.i32_32_store(0,42);e.i32_32_load(0)')===42,'Same instance works after cancellation')
    a.dispose();runtimes[0].dispose();b.dispose();runtimes[1].dispose()
    const final=stats();check(final.bytes===0&&final.references===0&&final.allocations===0,'All memory and waiter references released')
    return {cases,interop,timeout:true,growthWhileWaiting:true,cancellation:true,recovery:42,finalBytes:final.bytes,finalReferences:final.references}
  }finally{
    for(const task of tasks){task.cancel();task.step();if(task.status()===2){task.takeResult().dispose();task.dispose()}}
    for(const ctx of contexts)if(ctx.alive)ctx.dispose()
    for(const rt of runtimes)if(rt.alive)rt.dispose()
  }
}
