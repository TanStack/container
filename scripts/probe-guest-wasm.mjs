import {readFileSync,writeFileSync} from 'node:fs'
import {newQuickJSWASMModuleFromVariant,newVariant} from 'quickjs-emscripten-core'
import SYNC from '@jitl/quickjs-wasmfile-release-sync'
import loader from '../public/quickjs-als-wasm/engine.mjs'
import {guestWasmCases} from '../fixtures/guest-wasm-cases.mjs'
import {runInNewContext} from 'node:vm'
import {guestWasmInputHashes} from './guest-wasm-evidence.mjs'
const inputs=guestWasmInputHashes()
const engine=await newQuickJSWASMModuleFromVariant(newVariant({...SYNC,importModuleLoader:async()=>loader},{wasmBinary:readFileSync('public/quickjs-als-wasm/engine.wasm')}))
const bootstrap=readFileSync('src/sandbox/guest-wasm.js','utf8')
const control=Uint8Array.from(readFileSync('public/wasm-interpreter-probe/controls.wasm')),md4=Uint8Array.from(readFileSync('public/wasm-interpreter-probe/webpack-md4.wasm'))
const rows=[]
for(const fixture of guestWasmCases){
  const runtime=engine.newRuntime();runtime.setMemoryLimit(16*1024*1024);runtime.setMaxStackSize(512*1024)
  const deadline=Date.now()+3000;runtime.setInterruptHandler(()=>Date.now()>deadline)
  const context=runtime.newContext()
  let actual,error
  const expected=runInNewContext(fixture.code,{control,md4,WebAssembly},{timeout:3000})
  try{
    context.unwrapResult(context.evalCode(bootstrap+`;const control=new Uint8Array(${JSON.stringify([...control])});const md4=new Uint8Array(${JSON.stringify([...md4])});`)).dispose()
    const result=context.evalCode(fixture.code)
    if(result.error)error=context.dump(result.error);else actual=context.dump(result.value)
    result.dispose()
  }finally{context.dispose();runtime.dispose()}
  const passed=!error&&actual===expected;rows.push({name:fixture.name,passed,actual,expected,error});console.log(passed?'PASS':'FAIL',fixture.name,error??actual)
}
writeFileSync('reports/guest-wasm-node.json',JSON.stringify({engine:JSON.parse(readFileSync('public/quickjs-als-wasm/build.json','utf8')),inputs,rows},null,2)+'\n')
if(rows.some(row=>!row.passed))process.exitCode=1
