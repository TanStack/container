export async function runWasmFiber(engine,bytes,bootstrap){
  const check=(condition,label)=>{if(!condition)throw Error(label)}
  const runtimes=[],contexts=[],tasks=new Set()
  const create=()=>{const runtime=engine.newRuntime();runtime.setMemoryLimit(16*1024*1024);runtime.setMaxStackSize(256*1024);runtimes.push(runtime);const context=runtime.newContext();contexts.push(context);return context}
  const a=create(),b=create()
  const unwrap=(context,result)=>{if(result.error){const error=context.dump(result.error);result.dispose();throw Error(JSON.stringify(error))}return result.value}
  const evaluate=(context,source)=>unwrap(context,context.evalCode(source))
  const fiber=(context,source)=>{const task=context.startFiberEval(source,'wasm-fiber.js',0);tasks.add(task);return task}
  const take=(context,task,expected)=>{
    check(task.status()===2,'Fiber completed')
    const result=task.takeResult()
    try{if(expected==='error')check(Boolean(result.error),'Cancellation produces guest exception');else{const value=unwrap(context,result);try{check(context.getNumber(value)===expected,'Expected result '+expected)}finally{value.dispose()}}}
    finally{if(expected==='error')result.dispose();task.dispose();tasks.delete(task)}
  }
  try{
    for(const context of contexts){evaluate(context,bootstrap).dispose();evaluate(context,`globalThis.module=new WebAssembly.Module(new Uint8Array(${JSON.stringify(Array.from(bytes))}))`).dispose()}
    const shared=evaluate(a,'new SharedArrayBuffer(4)');a.setProp(a.global,'shared',shared)
    const alias=unwrap(b,b.cloneSharedBufferFrom(a,shared));b.setProp(b.global,'shared',alias);alias.dispose();shared.dispose()
    evaluate(a,"globalThis.instance=new WebAssembly.Instance(module,{env:{pause(){const result=Atomics.wait(new Int32Array(shared),0,0);if(result!=='ok')throw Error(result)}}})").dispose()
    evaluate(b,'globalThis.instance=new WebAssembly.Instance(module,{env:{pause(){}}})').dispose()
    for(let index=0;index<3;index++){
      const task=fiber(a,'instance.exports.run()')
      check(task.step()===1&&task.atomicWait()===Infinity,'WASM import parks in native guest atomic wait')
      const peer=fiber(b,'instance.exports.run()');check(peer.step()===2,'Peer WASM runs while parent parked');take(b,peer,42)
      evaluate(b,'new Uint32Array(instance.exports.memory.buffer)[0]=99').dispose()
      const notified=evaluate(b,'Atomics.notify(new Int32Array(shared),0,1)')
      check(b.getNumber(notified)===1,'Peer notifies parent');notified.dispose()
      check(task.atomicReady()&&task.step()===2,'Parent WASM resumes');take(a,task,42)
    }
    const cancelled=fiber(a,'instance.exports.run()')
    check(cancelled.step()===1&&cancelled.cancel()&&cancelled.step()===2,'Cancelled WASM import unwinds');take(a,cancelled,'error')
    const recovery=fiber(a,'instance.exports.run()')
    check(recovery.step()===1,'Same instance can park again after cancellation')
    evaluate(b,'Atomics.notify(new Int32Array(shared),0,1)').dispose()
    check(recovery.step()===2,'Recovery resumes');take(a,recovery,42)
    const departing=create()
    evaluate(departing,bootstrap).dispose()
    evaluate(departing,`globalThis.instance=new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(${JSON.stringify(Array.from(bytes))})),{env:{pause(){}}})`).dispose()
    const source=a.getProp(a.global,'shared'),departureAlias=unwrap(departing,departing.cloneSharedBufferFrom(a,source))
    departing.setProp(departing.global,'shared',departureAlias);source.dispose();departureAlias.dispose()
    const survivor=fiber(a,'instance.exports.run()');check(survivor.step()===1,'Survivor parks before peer teardown')
    const departingCall=fiber(departing,'instance.exports.run()');check(departingCall.step()===2,'Departing peer runs WASM');take(departing,departingCall,42)
    evaluate(departing,'Atomics.notify(new Int32Array(shared),0,1)').dispose()
    departing.dispose();runtimes.at(-1).dispose()
    check(survivor.step()===2,'Survivor resumes after peer runtime teardown');take(a,survivor,42)
    const stats=unwrap(b,b.sharedStorageStats());try{check(b.dump(stats).references===2,'No retained waiter after recovery')}finally{stats.dispose()}
    return {repeats:3,wasmImportPark:true,peerWasm:true,ownMemory:42,cancellation:true,recovery:42,peerTeardown:true,waiterReferencesReleased:true}
  }finally{
    for(const task of tasks){task.cancel();task.step();if(task.status()===2){task.takeResult().dispose();task.dispose()}}
    for(const context of contexts)if(context.alive)context.dispose()
    for(const runtime of runtimes)if(runtime.alive)runtime.dispose()
  }
}
