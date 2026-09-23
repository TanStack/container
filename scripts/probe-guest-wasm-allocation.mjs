import {readFileSync,writeFileSync} from 'node:fs'
import {newQuickJSWASMModuleFromVariant,newVariant} from 'quickjs-emscripten-core'
import SYNC from '@jitl/quickjs-wasmfile-release-sync'
import loader from '../public/quickjs-als-wasm/engine.mjs'
import {guestWasmInputHashes} from './guest-wasm-evidence.mjs'
const inputs=guestWasmInputHashes()
process.setUncaughtExceptionCaptureCallback(error=>{console.error(String(error));process.exitCode=1})
const engine=await newQuickJSWASMModuleFromVariant(newVariant({...SYNC,importModuleLoader:async()=>loader},{wasmBinary:readFileSync('public/quickjs-als-wasm/engine.wasm')}))
const bootstrap=readFileSync('src/sandbox/guest-wasm.js','utf8')
const bytes=JSON.stringify([...readFileSync('public/wasm-interpreter-probe/controls.wasm')]),rows=[]
const callbackBytes=JSON.stringify([...readFileSync('public/guest-wasm/callback.wasm')])
const memoryBytes=JSON.stringify([...readFileSync('public/guest-wasm/memory-import.wasm')])
const blockBytes=JSON.stringify([...readFileSync('public/compiler-depth/block-256.wasm')])
const elseBytes=JSON.stringify([...readFileSync('public/compiler-depth/else-32.wasm')])
const globalBytes=JSON.stringify([...readFileSync('public/guest-wasm/global-import.wasm')])
const tableBytes=JSON.stringify([...readFileSync('public/guest-wasm/table-owner.wasm')]),tableImportBytes=JSON.stringify([...readFileSync('public/guest-wasm/table-import.wasm')])
const phases={
  module:{setup:'',code:'return new WebAssembly.Module(bytes)'},
  instance:{setup:'const module=new WebAssembly.Module(bytes);',code:'return new WebAssembly.Instance(module)'},
  buffer:{setup:'const instance=new WebAssembly.Instance(new WebAssembly.Module(bytes));',code:'return instance.exports.memory.buffer'},
  grow:{setup:'const instance=new WebAssembly.Instance(new WebAssembly.Module(bytes));globalThis.old=instance.exports.memory.buffer;',code:'return instance.exports.memory.grow(1)'},
  import_instance:{setup:'const module=new WebAssembly.Module(callbackBytes);',code:'return new WebAssembly.Instance(module,{host:{callback:n=>n}})'},
  callback:{setup:'const instance=new WebAssembly.Instance(new WebAssembly.Module(callbackBytes),{host:{callback:()=>new Array(512).fill(1).length}});',code:'return instance.exports.call(3)'},
  memory_new:{setup:'',code:'return new WebAssembly.Memory({initial:1,maximum:8})'},
  memory_import:{setup:'const module=new WebAssembly.Module(memoryBytes),memory=new WebAssembly.Memory({initial:1,maximum:8});new Uint8Array(memory.buffer)[0]=23;',code:'return new WebAssembly.Instance(module,{host:{memory,callback:n=>n}})'},
  memory_shared_grow:{setup:'const module=new WebAssembly.Module(memoryBytes),memory=new WebAssembly.Memory({initial:1,maximum:8});const instance=new WebAssembly.Instance(module,{host:{memory,callback:n=>n}});new Uint8Array(memory.buffer)[0]=23;globalThis.old=memory.buffer;',code:'return memory.grow(1)'},
  compile_blocks:{setup:'',code:'return new WebAssembly.Module(blockBytes)'},
  compile_else:{setup:'',code:'return new WebAssembly.Module(elseBytes)'},
  global_new:{setup:'',code:'return new WebAssembly.Global({value:"i64",mutable:true},9007199254740995n)'},
  global_import:{setup:'const module=new WebAssembly.Module(globalBytes),global=new WebAssembly.Global({value:"i32",mutable:true},17);',code:'return new WebAssembly.Instance(module,{host:{value:global,constant:23,long:1n}})'},
  global_get:{setup:'const global=new WebAssembly.Global({value:"i64",mutable:true},9007199254740995n);',code:'return global.value'},
  global_set:{setup:'const global=new WebAssembly.Global({value:"i32",mutable:true},17);',code:'global.value={valueOf(){return new Array(512).fill(1).length}};return global.value'},
  table_new:{setup:'',code:'return new WebAssembly.Table({element:"anyfunc",initial:4096,maximum:8192})'},
  table_instance:{setup:'const module=new WebAssembly.Module(tableBytes);',code:'return new WebAssembly.Instance(module,{host:{callback:n=>n}})'},
  table_import:{setup:'const module=new WebAssembly.Module(tableImportBytes),source=new WebAssembly.Instance(new WebAssembly.Module(tableBytes),{host:{callback:n=>n}}).exports,table=source.table;',code:'return new WebAssembly.Instance(module,{host:{table}})'},
  table_get:{setup:'const table=new WebAssembly.Table({element:"anyfunc",initial:2,maximum:8});new WebAssembly.Instance(new WebAssembly.Module(tableBytes),{host:{callback:n=>n}}).exports.table.get(0);const source=new WebAssembly.Instance(new WebAssembly.Module(tableBytes),{host:{callback:n=>n}}).exports;table.set(0,source.read);',code:'return table.get(0)'},
  table_grow:{setup:'const source=new WebAssembly.Instance(new WebAssembly.Module(tableBytes),{host:{callback:n=>n}}).exports,table=new WebAssembly.Table({element:"anyfunc",initial:2,maximum:8192},source.read);',code:'return table.grow(4096,source.double)'},
  table_set:{setup:'const source=new WebAssembly.Instance(new WebAssembly.Module(tableBytes),{host:{callback:n=>n}}).exports,table=source.table;',code:'table.set(0,source.double);return table.get(0)'},
}
for(const [phase,fixture] of Object.entries(phases))for(let headroom=0;headroom<=512*1024;headroom+=2048){
  const runtime=engine.newRuntime(),context=runtime.newContext();runtime.setMemoryLimit(16*1024*1024);runtime.setMaxStackSize(512*1024)
  runtime.context=context
  let attempt
  try{
    context.unwrapResult(context.evalCode(bootstrap+`;const bytes=new Uint8Array(${bytes}),callbackBytes=new Uint8Array(${callbackBytes}),memoryBytes=new Uint8Array(${memoryBytes}),blockBytes=new Uint8Array(${blockBytes}),elseBytes=new Uint8Array(${elseBytes}),globalBytes=new Uint8Array(${globalBytes}),tableBytes=new Uint8Array(${tableBytes}),tableImportBytes=new Uint8Array(${tableImportBytes});${fixture.setup};function attempt(){${fixture.code}}`)).dispose()
    attempt=context.getProp(context.global,'attempt')
    const usage=runtime.computeMemoryUsage(),used=context.dump(usage).malloc_size;usage.dispose()
    if(!Number.isSafeInteger(used)||used<=0)throw Error('Missing allocation measurement')
    runtime.setMemoryLimit(used+headroom)
    const result=context.callFunction(attempt,context.undefined)
    runtime.setMemoryLimit(16*1024*1024)
    const failed=!!result.error,error=failed?context.dump(result.error):undefined;result.dispose()
    const recovery=context.unwrapResult(context.evalCode('new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.answer()'))
    const answer=context.getNumber(recovery);recovery.dispose()
    if(phase==='memory_import'||phase==='memory_shared_grow')context.unwrapResult(context.evalCode('if(new WebAssembly.Instance(module,{host:{memory,callback:n=>n}}).exports.read(0)!==23)throw Error("lost shared memory");memory.grow(0)')).dispose()
    if(phase==='global_import')context.unwrapResult(context.evalCode('if(new WebAssembly.Instance(module,{host:{value:global,constant:23,long:1n}}).exports.read()!==17)throw Error("lost global cell")')).dispose()
    if(phase==='global_set')context.unwrapResult(context.evalCode(`if(global.value!==${failed?17:512})throw Error("partial global write")`)).dispose()
    if(phase==='table_import')context.unwrapResult(context.evalCode('if(new WebAssembly.Instance(module,{host:{table}}).exports.call(0,25)!==42)throw Error("lost table function")')).dispose()
    if(phase==='table_grow')context.unwrapResult(context.evalCode(`if(table.length!==${failed?2:4098}||table.get(0)(25)!==42)throw Error("partial table growth");table.grow(0)`)).dispose()
    if(phase==='table_set')context.unwrapResult(context.evalCode('if(table.get(0)!==source.read&&table.get(0)!==source.double)throw Error("lost table entry");table.set(0,source.read);if(table.get(0)(25)!==42)throw Error("table set recovery")')).dispose()
    rows.push({phase,headroom,failed,error,answer})
    if(answer!==42)throw Error('Recovery failed')
  }catch(error){console.error('Allocation case',phase,headroom,error.stack??String(error));throw error}finally{
    try{runtime.setMemoryLimit(16*1024*1024);attempt?.dispose();context.dispose();runtime.dispose()}
    catch(error){writeFileSync('reports/guest-wasm-allocation-failure.json',JSON.stringify({phase,headroom,last:rows.at(-1),error:String(error)},null,2)+'\n');throw error}
  }
}
const summary=Object.fromEntries(Object.keys(phases).map(phase=>{const selected=rows.filter(row=>row.phase===phase);return[phase,{failed:selected.filter(row=>row.failed).length,passed:selected.filter(row=>!row.failed).length}]}))
writeFileSync('reports/guest-wasm-allocation.json',JSON.stringify({engine:JSON.parse(readFileSync('public/quickjs-als-wasm/build.json','utf8')),inputs,summary,rows},null,2)+'\n')
console.log(summary)
if(Object.values(summary).some(row=>!row.failed||!row.passed))throw Error('Each phase must include allocation failure and success')
