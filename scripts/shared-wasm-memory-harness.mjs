export function memoryCases(api,sharedBytes,plainBytes){
  const check=(condition,label)=>{if(!condition)throw Error(label)}
  let missing=false;try{new api.Memory({initial:1,shared:true})}catch{missing=true}
  check(missing,'Shared maximum required')
  const empty=new api.Memory({initial:0,maximum:0,shared:true}),emptyBuffer=empty.buffer
  check(emptyBuffer instanceof SharedArrayBuffer&&emptyBuffer.byteLength===0,'Zero capacity shared buffer')
  check(empty.grow(0)===0&&empty.buffer!==emptyBuffer,'Zero capacity grow zero refreshes buffer')
  let emptyExceeded=false;try{empty.grow(1)}catch{emptyExceeded=true}
  check(emptyExceeded,'Zero capacity maximum enforced')
  const module=new api.Module(new Uint8Array(sharedBytes)),plain=new api.Module(new Uint8Array(plainBytes))
  const memory=new api.Memory({initial:1,maximum:2,shared:true})
  const original=memory.buffer
  check(original===memory.buffer,'Repeated buffer access preserves identity')
  const instance=new api.Instance(module,{env:{memory}})
  check(instance.exports.memory===memory&&instance.exports.memory.buffer===original,'Export preserves imported memory identity')
  instance.exports.store(0,41);check(new Int32Array(original)[0]===41&&instance.exports.load(0)===41,'Loads and stores share bytes')
  check(memory.grow(0)===1&&memory.buffer!==original,'JS grow zero refreshes buffer')
  const beforeGrow=memory.buffer
  check(memory.grow(1)===1&&instance.exports.size()===2,'JS growth changes WASM size')
  check(original.byteLength===65536&&beforeGrow.byteLength===65536&&memory.buffer.byteLength===131072,'Old shared views retain lengths')
  check(new Uint8Array(memory.buffer,65536).every(value=>value===0),'New page is zero')
  check(new Int32Array(original)[0]===41,'Old view remains live')
  let exceeded=false;try{memory.grow(1)}catch{exceeded=true}
  check(exceeded,'JS maximum enforced')
  check(instance.exports.grow(1)===-1,'WASM maximum returns failure')
  let sharedMismatch=false,plainMismatch=false
  try{new api.Instance(module,{env:{memory:new api.Memory({initial:1,maximum:2})}})}catch{sharedMismatch=true}
  try{new api.Instance(plain,{env:{memory}})}catch{plainMismatch=true}
  check(sharedMismatch&&plainMismatch,'Import sharedness enforced in both directions')
  const nativeMemory=new api.Memory({initial:1,maximum:2,shared:true}),nativeInstance=new api.Instance(module,{env:{memory:nativeMemory}})
  const first=nativeMemory.buffer
  check(nativeInstance.exports.grow(0)===1&&nativeMemory.buffer!==first,'WASM grow zero refreshes buffer')
  const second=nativeMemory.buffer
  nativeInstance.exports.store(4,73)
  check(nativeInstance.exports.grow(1)===1&&nativeInstance.exports.size()===2,'WASM growth changes size')
  check(first.byteLength===65536&&second.byteLength===65536&&nativeMemory.buffer.byteLength===131072,'WASM growth preserves old views')
  check(new Int32Array(second)[1]===73&&new Uint8Array(nativeMemory.buffer,65536).every(value=>value===0),'WASM growth preserves data and zeroes new page')
  return {requiredMaximum:true,zeroCapacity:true,bufferIdentity:true,growZero:true,growOne:true,oldViews:true,zeroFill:true,maximum:true,sharedness:true,exportIdentity:true,wasmGrowth:true}
}

export async function runSharedWasmMemory(engine,sharedBytes,plainBytes,bootstrap){
  const check=(condition,label)=>{if(!condition)throw Error(label)}
  const runtimes=[],contexts=[]
  const create=()=>{const rt=engine.newRuntime();rt.setMemoryLimit(16*1024*1024);runtimes.push(rt);const ctx=rt.newContext();contexts.push(ctx);return ctx}
  const a=create(),b=create(),observer=create()
  const unwrap=(ctx,result)=>{if(result.error){const error=ctx.dump(result.error);result.dispose();throw Error(JSON.stringify(error))}return result.value}
  const evaluate=(ctx,source)=>unwrap(ctx,ctx.evalCode(source))
  const stats=()=>{const value=unwrap(observer,observer.sharedStorageStats());try{return observer.dump(value)}finally{value.dispose()}}
  try{
    const initial=stats()
    evaluate(a,bootstrap).dispose()
    const result=evaluate(a,`JSON.stringify((${memoryCases.toString()})(WebAssembly,${JSON.stringify(Array.from(sharedBytes))},${JSON.stringify(Array.from(plainBytes))}))`)
    const cases=JSON.parse(a.getString(result));result.dispose()
    const capacity=evaluate(a,'(()=>{const memory=new WebAssembly.Memory({initial:1,maximum:65536,shared:true});new Uint8Array(memory.buffer)[0]=73;const old=memory.buffer;try{memory.grow(256);return false}catch{return memory.buffer===old&&old.byteLength===65536&&new Uint8Array(old)[0]===73}})()')
    check(a.dump(capacity)===true,'Large maximum is metadata; rejected growth preserves memory');capacity.dispose()
    const buffer=evaluate(a,'globalThis.memory=new WebAssembly.Memory({initial:1,maximum:2,shared:true});new Int32Array(memory.buffer)[0]=99;memory.buffer')
    const alias=unwrap(b,b.cloneSharedBufferFrom(a,buffer));b.setProp(b.global,'alias',alias);alias.dispose();buffer.dispose()
    a.dispose();runtimes[0].dispose()
    const survivor=evaluate(b,'new Int32Array(alias)[0]');check(b.getNumber(survivor)===99,'SAB survives creator memory and runtime');survivor.dispose()
    b.dispose();runtimes[1].dispose()
    check(stats().wrappers===initial.wrappers,'WASM buffer survivor teardown restores wrapper baseline')
    const creator=create(),receiver=create()
    const initialize=ctx=>evaluate(ctx,'globalThis.__webContainerHost={shared:{}};'+bootstrap).dispose()
    initialize(creator)
    const handle=evaluate(creator,'globalThis.memory=new WebAssembly.Memory({initial:1,maximum:2,shared:true});new Int32Array(memory.buffer)[0]=123;__webContainerHost.shared.wasmMemory.unwrap(memory)')
    const lease=creator.retainSharedWasmMemory(handle),abandoned=creator.retainSharedWasmMemory(handle)
    handle.dispose()
    abandoned.dispose();abandoned.dispose()
    const ordinary=evaluate(creator,'__webContainerHost.shared.wasmMemory.unwrap(new WebAssembly.Memory({initial:1,maximum:2}))')
    let rejected=false;try{creator.retainSharedWasmMemory(ordinary)}catch{rejected=true}finally{ordinary.dispose()}
    check(rejected,'Unshared memory cannot be retained')
    creator.dispose();runtimes[3].dispose()
    check(stats().wrappers===initial.wrappers,'Queued Memory control lease does not retain a QuickJS SAB wrapper')
    initialize(receiver)
    const adopted=unwrap(receiver,lease.adopt(receiver))
    check(!lease.alive,'Successful adoption consumes lease')
    check(stats().wrappers===initial.wrappers,'Memory control adoption does not create a SAB before buffer access')
    receiver.setProp(receiver.global,'adopted',adopted);adopted.dispose();lease.dispose()
    const live=evaluate(receiver,`(()=>{const memory=__webContainerHost.shared.wasmMemory.wrap(adopted),old=memory.buffer;
      if(!(memory instanceof WebAssembly.Memory)||new Int32Array(old)[0]!==123)throw Error('Memory creator ownership');
      if(memory.grow(1)!==1||memory.buffer.byteLength!==131072||old.byteLength!==65536)throw Error('Adopted growth');
      new Int32Array(memory.buffer)[0]=124;return new Int32Array(old)[0]===124})()`)
    check(receiver.dump(live)===true,'Adopted memory grows after creator teardown');live.dispose()
    receiver.dispose();runtimes[4].dispose()
    const final=stats();check(final.bytes===initial.bytes&&final.references===initial.references&&final.allocations===initial.allocations,'Final group ownership returns to baseline')
    check(final.wrappers===initial.wrappers,'Final WASM memory cleanup restores registered wrapper baseline')
    check(final.growths>initial.growths,'Growth relocated backing allocations')
    check(final.peakBytes<=final.maxBytes,'Growth peak stayed within group budget')
    return {...cases,groupCapacityRejection:true,sabCreatorTeardown:true,memoryCreatorTeardown:true,memoryLeaseRelease:true,unsharedMemoryRejection:true,wrapperLifecycle:true,backingGrowths:final.growths-initial.growths,peakBytes:final.peakBytes,finalWrappers:final.wrappers,finalBytes:final.bytes,finalReferences:final.references}
  }finally{for(const ctx of contexts)if(ctx.alive)ctx.dispose();for(const rt of runtimes)if(rt.alive)rt.dispose()}
}
