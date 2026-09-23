import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {runInNewContext} from 'node:vm'
import {createHash} from 'node:crypto'
import {guestWasmCases} from '../fixtures/guest-wasm-cases.mjs'

const directory=resolve('public/quickjs-als-asyncify-wasm-atomics-fibers-shared-storage-simd-lazy-wasm')
const metadata=JSON.parse(readFileSync(join(directory,'build.json')))
assert.equal(metadata.guestWasm.lazyCompilation.validation,'eager')
const bootstrap=readFileSync('src/sandbox/guest-wasm.js','utf8')
assert.equal(metadata.guestWasm.bootstrapSHA256,createHash('sha256').update(bootstrap).digest('hex'))
assert.equal(metadata.guestWasm.bridgeSHA256,createHash('sha256').update(readFileSync('src/sandbox/guest-wasm.c')).digest('hex'))
const core=await import(pathToFileURL(join(directory,'core.mjs')).href)
const {default:factory}=await import(pathToFileURL(join(directory,'engine.mjs')).href)
const {QuickJSAsyncFFI}=await import(pathToFileURL(join(directory,'ffi.mjs')).href)
const engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>QuickJSAsyncFFI,importModuleLoader:async()=>()=>factory({wasmBinary:readFileSync(join(directory,'engine.wasm'))})})
const control=Uint8Array.from(readFileSync('public/wasm-interpreter-probe/controls.wasm'))
const md4=Uint8Array.from(readFileSync('public/wasm-interpreter-probe/webpack-md4.wasm'))
const rows=[]
for(const fixture of guestWasmCases){
  const expected=runInNewContext(fixture.code,{control,md4,WebAssembly},{timeout:3000})
  const runtime=engine.newRuntime();runtime.setMemoryLimit(64*1024*1024);runtime.setMaxStackSize(256*1024)
  const deadline=Date.now()+3000;runtime.setInterruptHandler(()=>Date.now()>deadline)
  const context=runtime.newContext();let actual,error
  try{
    context.unwrapResult(context.evalCode(bootstrap+`;const control=new Uint8Array(${JSON.stringify([...control])});const md4=new Uint8Array(${JSON.stringify([...md4])});`)).dispose()
    const result=context.evalCode(fixture.code)
    if(result.error)error=context.dump(result.error);else actual=context.dump(result.value)
    result.dispose()
  }finally{context.dispose();runtime.dispose()}
  rows.push({name:fixture.name,expected,actual,error,passed:!error&&actual===expected})
}
writeFileSync('reports/wasm-lazy-reference.json',JSON.stringify({scope:'Opt-in lazy engine against existing ordinary WASM reference cases, not SDK acceptance',directory,metadata,rows},null,2)+'\n')
console.log(JSON.stringify({total:rows.length,passed:rows.filter(row=>row.passed).length,failures:rows.filter(row=>!row.passed)}))
if(rows.some(row=>!row.passed))process.exitCode=1
