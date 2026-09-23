import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {newQuickJSWASMModuleFromVariant,newVariant} from 'quickjs-emscripten-core'
import SYNC from '@jitl/quickjs-wasmfile-release-sync'

for(const directory of ['quickjs-als','quickjs-als-wasm']){
  const loader=(await import('../public/'+directory+'/engine.mjs')).default
  const engine=await newQuickJSWASMModuleFromVariant(newVariant({...SYNC,importModuleLoader:async()=>loader},{wasmBinary:readFileSync('public/'+directory+'/engine.wasm')}))
  const runtime=engine.newRuntime(),context=runtime.newContext()
  const evaluate=code=>{const result=context.evalCode(code);try{return result.error?{error:context.dump(result.error)}:{value:context.dump(result.value)}}finally{result.dispose()}}
  try{
    assert.deepEqual(evaluate('globalThis.completed=0;for(let i=0;i<12;i++)Promise.resolve().then(()=>completed++);undefined'),{value:undefined})
    for(const invalid of ['0','101','1.5','NaN','Infinity']){
      const result=evaluate('__qjsExecutePendingJobs('+invalid+')')
      assert.equal(result.error?.name,'RangeError')
      assert.equal(evaluate('completed').value,0)
    }
    assert.equal(evaluate('__qjsExecutePendingJobs(1)').value,1)
    assert.equal(evaluate('completed').value,1)
    assert.equal(evaluate('__qjsExecutePendingJobs(3)').value,3)
    assert.equal(evaluate('completed').value,4)
    assert.equal(evaluate('__qjsExecutePendingJobs()').value,8)
    assert.equal(evaluate('completed').value,12)
    assert.equal(evaluate('__qjsExecutePendingJobs(1)').value,0)
    console.log(directory+': bounded pump, default drain and rejected inputs pass')
  }finally{context.dispose();runtime.dispose()}
}
