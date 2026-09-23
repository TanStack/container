import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import ASYNCIFY from '@jitl/quickjs-wasmfile-release-asyncify'
import * as core from '../public/quickjs-als-asyncify-wasm-cooperative/core.mjs'
import loader from '../public/quickjs-als-asyncify-wasm-cooperative/engine.mjs'
import {QuickJSAsyncFFI} from '../public/quickjs-als-asyncify-wasm-cooperative/ffi.mjs'
import {guestWasmCases} from '../fixtures/guest-wasm-cases.mjs'

const engine=await core.newQuickJSAsyncWASMModuleFromVariant(core.newVariant({
  ...ASYNCIFY,importModuleLoader:async()=>loader,importFFI:async()=>QuickJSAsyncFFI,
},{wasmBinary:readFileSync('public/quickjs-als-asyncify-wasm-cooperative/engine.wasm')}))
const bootstrap=readFileSync('src/sandbox/guest-wasm.js','utf8')
const control=Uint8Array.from(readFileSync('public/wasm-interpreter-probe/controls.wasm'))
const md4=Uint8Array.from(readFileSync('public/wasm-interpreter-probe/webpack-md4.wasm'))
let passed=0
const failures=[]
for(const fixture of guestWasmCases){
  console.log('RUN',fixture.name)
  const runtime=engine.newRuntime(),context=runtime.newContext()
  runtime.setMemoryLimit(16*1024*1024);runtime.setMaxStackSize(512*1024)
  const deadline=performance.now()+5000
  runtime.setInterruptHandler(()=>performance.now()>deadline)
  try{
    const expected=runInNewContext(fixture.code,{control,md4,WebAssembly},{timeout:3000})
    context.unwrapResult(await context.evalCodeAsync(bootstrap+';const control=new Uint8Array('+JSON.stringify([...control])+');const md4=new Uint8Array('+JSON.stringify([...md4])+');')).dispose()
    const result=await context.evalCodeAsync(fixture.code)
    const actual=context.dump(result.error??result.value)
    const matches=!result.error&&actual===expected
    result.dispose()
    if(matches)passed++;else failures.push({name:fixture.name,expected,actual})
  }catch(error){console.error('CASE_ERROR',fixture.name,error);failures.push({name:fixture.name,error:String(error)})}
  finally{context.dispose();runtime.dispose()}
}
console.log(JSON.stringify({passed,total:guestWasmCases.length,failures},null,2))
if(failures.length)process.exitCode=1
