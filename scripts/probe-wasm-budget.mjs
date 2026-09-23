import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {newQuickJSWASMModuleFromVariant,newVariant} from 'quickjs-emscripten-core'
import SYNC from '@jitl/quickjs-wasmfile-release-sync'
import loader from '../public/quickjs-als-wasm/engine.mjs'
import {guestWasmInputHashes} from './guest-wasm-evidence.mjs'

const names=['fallback-finite','fallback-loop','host-finite','host-loop','host-start-loop','handler-removed']
const name=process.argv[2]
if(!name){
  const rows=names.map(name=>{
    // An outer process deadline detects a broken interrupt path without hanging the runner.
    const run=spawnSync(process.execPath,[fileURLToPath(import.meta.url),name],{encoding:'utf8',timeout:20000})
    let evidence;try{evidence=JSON.parse(run.stdout)}catch{}
    const row={name,passed:run.status===0,status:run.status,signal:run.signal,evidence,error:run.error?.message,stderr:run.stderr}
    console.log(JSON.stringify(row));return row
  })
  writeFileSync('reports/wasm-budget.json',JSON.stringify({engine:JSON.parse(readFileSync('public/quickjs-als-wasm/build.json')),inputs:guestWasmInputHashes(),rows},null,2)+'\n')
  if(rows.some(row=>!row.passed))process.exitCode=1
}else{
  assert(names.includes(name))
  const engine=await newQuickJSWASMModuleFromVariant(newVariant({...SYNC,importModuleLoader:async()=>loader},{wasmBinary:readFileSync('public/quickjs-als-wasm/engine.wasm')}))
  const runtime=engine.newRuntime();runtime.setMemoryLimit(16*1024*1024);runtime.setMaxStackSize(512*1024)
  const context=runtime.newContext()
  const evaluate=code=>{
    const result=context.evalCode(code)
    try{return result.error?{error:context.dump(result.error)}:{value:context.dump(result.value)}}finally{result.dispose()}
  }
  const budget=[...readFileSync('public/guest-wasm/budget.wasm')]
  const start=[...readFileSync('public/wasm-interpreter-probe/start-loop.wasm')]
  try{
    assert(!evaluate(readFileSync('src/sandbox/guest-wasm.js','utf8')+`;const e=new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(${JSON.stringify(budget)}))).exports;`).error)
    let polls=0;const began=performance.now(),deadline=began+(name==='host-finite'?12000:150)
    if(name.startsWith('host-')||name==='handler-removed')runtime.setInterruptHandler(()=>{polls++;return performance.now()>deadline})
    if(name==='handler-removed')runtime.removeInterruptHandler()
    const code=name==='host-start-loop'?`new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(${JSON.stringify(start)})))`:
      name.endsWith('finite')?'e.finite(50000000)':'e.loop()'
    // The script must not catch a host deadline and continue running.
    const result=evaluate(`try{${code}}catch(error){if(${JSON.stringify(name.startsWith('host-'))})globalThis.escaped=true;throw error}`)
    const durationMs=performance.now()-began
    if(name==='host-finite'){
      assert.deepEqual(result,{value:42});assert(polls>0)
    }else if(name.startsWith('host-')){
      assert.match(result.error?.message??'',/interrupted/);assert(polls>0);assert(durationMs<3000)
    }else{
      assert.match(result.error?.message??'',/gas/i);assert.equal(polls,0)
    }
    runtime.removeInterruptHandler()
    const recovery=evaluate('JSON.stringify([e.answer(),globalThis.escaped===true])')
    assert.equal(recovery.value,'[42,false]')
    console.log(JSON.stringify({name,result,durationMs,polls,recovery}))
  }finally{context.dispose();runtime.dispose()}
}
