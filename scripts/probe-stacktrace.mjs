import {readFileSync,writeFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {newQuickJSWASMModuleFromVariant,newVariant} from 'quickjs-emscripten-core'
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync'
import {stacktraceCases} from '../fixtures/stacktrace-cases.mjs'
import {createHash} from 'node:crypto'
const results=[]
for(const directory of ['quickjs-als','quickjs-als-wasm']){
  const loader=(await import('../public/'+directory+'/engine.mjs')).default
  const engine=await newQuickJSWASMModuleFromVariant(newVariant({...RELEASE_SYNC,importModuleLoader:async()=>loader},{wasmBinary:readFileSync('public/'+directory+'/engine.wasm')}))
  for(const fixture of stacktraceCases){
    const expected=runInNewContext(fixture.code,{}, {filename:'stack-capture.js',timeout:2000})
    const runtime=engine.newRuntime();runtime.setMemoryLimit(16*1024*1024);const deadline=Date.now()+2000;runtime.setInterruptHandler(()=>Date.now()>deadline)
    const ctx=runtime.newContext();let actual
    try{const result=ctx.evalCode(fixture.code,'stack-capture.js');actual=result.error?{error:ctx.dump(result.error)}:ctx.dump(result.value);(result.error??result.value).dispose()}
    finally{ctx.dispose();runtime.dispose()}
    const matches=JSON.stringify(expected)===JSON.stringify(actual);results.push({engine:directory,name:fixture.name,expected,actual,matches});console.log((matches?'PASS ':'GAP ')+directory+' '+fixture.name+(matches?'':': '+JSON.stringify({expected,actual})))
  }
}
writeFileSync('reports/stacktrace-native.json',JSON.stringify({node:process.version,engines:Object.fromEntries(['quickjs-als','quickjs-als-wasm'].map(d=>[d,JSON.parse(readFileSync('public/'+d+'/build.json'))])),corpusSHA256:createHash('sha256').update(readFileSync('fixtures/stacktrace-cases.mjs')).digest('hex'),results},null,2)+'\n')
if(results.some(r=>!r.matches))process.exitCode=1
