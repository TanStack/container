import {readFileSync,writeFileSync} from 'node:fs'
import {newQuickJSWASMModuleFromVariant,newVariant} from 'quickjs-emscripten-core'
import SYNC from '@jitl/quickjs-wasmfile-release-sync'
import loader from '../public/quickjs-als-wasm/engine.mjs'
import {guestWasmInputHashes} from './guest-wasm-evidence.mjs'

const engine=await newQuickJSWASMModuleFromVariant(newVariant({...SYNC,importModuleLoader:async()=>loader},{wasmBinary:readFileSync('public/quickjs-als-wasm/engine.wasm')}))
const bootstrap=readFileSync('src/sandbox/guest-wasm.js','utf8'),rows=[]
const setup=`
  const size=14*1024*1024,leb=[];let remaining=size;
  do{let byte=remaining&127;remaining>>>=7;leb.push(byte|(remaining?128:0))}while(remaining);
  globalThis.bytes=new Uint8Array(9+leb.length+size);
  bytes.set([0,97,115,109,1,0,0,0,0,...leb]);
  globalThis.tiny=new Uint8Array([0,97,115,109,1,0,0,0]);
`
// A custom section with an empty name and padding, valid in Node as well.
for(const headroom of [0,1024,65536,1024*1024,16*1024*1024,64*1024*1024]){
  const runtime=engine.newRuntime();runtime.setMemoryLimit(128*1024*1024);runtime.setMaxStackSize(512*1024)
  const deadline=Date.now()+15000;runtime.setInterruptHandler(()=>Date.now()>deadline)
  const context=runtime.newContext()
  try{
    context.unwrapResult(context.evalCode(bootstrap+setup)).dispose()
    const stats=runtime.computeMemoryUsage();const used=context.dump(stats).malloc_size;stats.dispose()
    runtime.setMemoryLimit(used+headroom)
    const attempt=context.evalCode('new WebAssembly.Instance(new WebAssembly.Module(bytes));true')
    const failed=!!attempt.error,error=attempt.error?context.dump(attempt.error):undefined;attempt.dispose()
    runtime.setMemoryLimit(128*1024*1024)
    context.unwrapResult(context.evalCode('new WebAssembly.Instance(new WebAssembly.Module(tiny));true')).dispose()
    const retry=context.evalCode('new WebAssembly.Instance(new WebAssembly.Module(bytes));true')
    if(retry.error)throw Error(JSON.stringify(context.dump(retry.error)))
    retry.dispose();rows.push({headroom,failed,error,recovered:true})
  }finally{runtime.setMemoryLimit(128*1024*1024);context.dispose();runtime.dispose()}
}
const oracle=Function(setup+'return WebAssembly.validate(bytes)')()
if(!oracle||!rows.some(row=>row.failed)||!rows.some(row=>!row.failed))throw Error('Missing success/failure coverage')
writeFileSync('reports/large-wasm.json',JSON.stringify({engine:JSON.parse(readFileSync('public/quickjs-als-wasm/build.json','utf8')),inputs:guestWasmInputHashes(),oracle,rows},null,2)+'\n')
console.log(JSON.stringify({oracle,rows},null,2))
