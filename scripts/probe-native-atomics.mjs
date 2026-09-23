import {readFileSync} from 'node:fs'
import {newQuickJSWASMModuleFromVariant,newVariant} from 'quickjs-emscripten-core'
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync'
const loader=(await import('../public/quickjs-als-atomics/engine.mjs')).default
const binary=readFileSync('public/quickjs-als-atomics/engine.wasm')
const module=new WebAssembly.Module(binary)
const engine=await newQuickJSWASMModuleFromVariant(newVariant({...RELEASE_SYNC,importModuleLoader:async()=>loader},{wasmBinary:binary}))
const runtime=engine.newRuntime(),ctx=runtime.newContext()
runtime.setMemoryLimit(16*1024*1024)
const source=`(()=>{
 const out=[];
 for(const Type of [Int8Array,Uint8Array,Int16Array,Uint16Array,Int32Array,Uint32Array,BigInt64Array,BigUint64Array]){
   const a=new Type(new SharedArrayBuffer(16)),big=Type===BigInt64Array||Type===BigUint64Array,v=n=>big?BigInt(n):n;
   out.push([Type.name,Atomics.store(a,0,v(7)),Atomics.add(a,0,v(3)),Atomics.sub(a,0,v(2)),Atomics.and(a,0,v(6)),Atomics.or(a,0,v(1)),Atomics.xor(a,0,v(2)),Atomics.exchange(a,0,v(4)),Atomics.compareExchange(a,0,v(4),v(9)),Atomics.load(a,0)].map(String));
 }
 out.push(['notify',Atomics.notify(new Int32Array(new SharedArrayBuffer(4)),0,1)]);
 return JSON.stringify(out)
})()`
try{
 const handle=ctx.unwrapResult(ctx.evalCode(source)),guest=ctx.getString(handle);handle.dispose()
 const native=eval(source)
 if(guest!==native)throw Error('Atomic operation results differ from Node: '+guest+' versus '+native)
 const wait=ctx.evalCode('Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,0)')
 let waitResult
 if(wait.error){waitResult=ctx.dump(wait.error);wait.error.dispose()}else{waitResult=ctx.dump(wait.value);wait.value.dispose()}
 console.log(JSON.stringify({matched:JSON.parse(guest).length,waitResult,imports:WebAssembly.Module.imports(module).filter(entry=>entry.kind==='memory')},null,2))
}finally{ctx.dispose();runtime.dispose()}
