import {readFileSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {runInNewContext} from 'node:vm'
import {newQuickJSWASMModuleFromVariant,newVariant} from 'quickjs-emscripten-core'
import SYNC from '@jitl/quickjs-wasmfile-release-sync'
import loader from '../public/quickjs-als-wasm/engine.mjs'
import {wasmTableCoreCases} from '../fixtures/wasm-table-cases.mjs'

// Exercise the interpreter's table instructions independently of the still-missing
// JavaScript Table bridge. No exported tables or native browser objects are used.
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex')
const inputs=JSON.parse(readFileSync('public/wasm-tables/manifest.json','utf8')).inputs
for(const [path,sha] of Object.entries(inputs))if(hash(path)!==sha)throw Error('Fixture manifest is stale: '+path)
for(const path of ['scripts/probe-wasm-table-core.mjs','scripts/prepare-wasm-tables.mjs','fixtures/wasm-table-cases.mjs'])inputs[path]=hash(path)
const fixtures=Object.fromEntries(['growth','elements'].map(name=>[name,[...readFileSync('public/wasm-tables/'+name+'.wasm')]]))
const cases=wasmTableCoreCases(fixtures)
const engineInfo=JSON.parse(readFileSync('public/quickjs-als-wasm/build.json','utf8'))
for(const path of ['public/quickjs-als-wasm/engine.wasm','public/quickjs-als-wasm/engine.mjs','src/sandbox/guest-wasm.js','src/sandbox/guest-wasm.c'])inputs[path]=hash(path)
if(inputs['public/quickjs-als-wasm/engine.wasm']!==engineInfo.wasmSha256||inputs['src/sandbox/guest-wasm.js']!==engineInfo.guestWasm.bootstrapSHA256||inputs['src/sandbox/guest-wasm.c']!==engineInfo.guestWasm.bridgeSHA256)throw Error('Candidate source and engine differ')
const engine=await newQuickJSWASMModuleFromVariant(newVariant({...SYNC,importModuleLoader:async()=>loader},{wasmBinary:readFileSync('public/quickjs-als-wasm/engine.wasm')}))
const bootstrap=readFileSync('src/sandbox/guest-wasm.js','utf8'),rows=[]
for(const fixture of cases){
  const code=fixture.code
  const expected=runInNewContext(code,{WebAssembly},{timeout:3000})
  const runtime=engine.newRuntime();runtime.setMemoryLimit(16*1024*1024);runtime.setMaxStackSize(512*1024)
  const deadline=Date.now()+3000;runtime.setInterruptHandler(()=>Date.now()>deadline)
  const context=runtime.newContext();let actual,error
  try{
    context.unwrapResult(context.evalCode(bootstrap)).dispose()
    const result=context.evalCode(code)
    if(result.error)error=context.dump(result.error);else actual=context.dump(result.value)
    result.dispose()
  }finally{context.dispose();runtime.dispose()}
  const passed=!error&&actual===expected
  rows.push({name:fixture.name,passed,expected,actual,error});console.log(passed?'PASS':'FAIL',fixture.name,JSON.stringify({expected,actual,error}))
}
writeFileSync(process.argv.includes('--before')?'reports/wasm-table-core-before.json':'reports/wasm-table-core.json',JSON.stringify({generatedAt:new Date().toISOString(),node:process.version,engine:engineInfo,inputs,rows},null,2)+'\n')
if(rows.some(row=>!row.passed))process.exitCode=1
