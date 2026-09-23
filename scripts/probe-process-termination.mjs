import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import SYNC from '@jitl/quickjs-wasmfile-release-sync'
import {newVariant} from 'quickjs-emscripten-core'

const directory=process.argv[2]??'quickjs-als-o2'
const core=await import('../public/'+directory+'/core.mjs')
const loader=(await import('../public/'+directory+'/engine.mjs')).default
const engine=await core.newQuickJSWASMModuleFromVariant(newVariant({...SYNC,importModuleLoader:async()=>loader},{wasmBinary:readFileSync('public/'+directory+'/engine.wasm')}))
for(const [name,source,jobs] of [
  ['synchronous',`try{terminate();seen.push('after')}catch(e){seen.push('catch')}finally{seen.push('finally')}`,false],
  ['async synchronous prefix',`(async()=>{terminate()})();seen.push('caller continued');`,false],
  ['promise callback',`Promise.resolve().then(()=>{try{terminate()}catch(e){seen.push('catch')}finally{seen.push('finally')}}).catch(()=>seen.push('rejection'));`,true],
  ['async function',`(async()=>{try{await 0;terminate()}catch(e){seen.push('catch')}finally{seen.push('finally')}})().catch(()=>seen.push('rejection'));`,true],
]){
  const runtime=engine.newRuntime(),context=runtime.newContext()
  try{
    const initializer=context.unwrapResult(context.evalCode('(binding)=>{globalThis.terminate=binding;globalThis.seen=[]}'))
    try{context.unwrapResult(context.initializeTermination(initializer)).dispose()}finally{initializer.dispose()}
    const result=context.evalCode(source)
    let stopped=!!result.error
    result.dispose()
    if(jobs){
      for(let i=0;i<10&&runtime.hasPendingJob()&&!stopped;i++){
        const step=runtime.executePendingJobs(1)
        stopped=!!step.error
        step.dispose()
      }
    }
    assert.equal(stopped,true,name+' must surface termination to the host')
    const seen=context.getProp(context.global,'seen')
    try{assert.deepEqual(context.dump(seen),[],name+' must bypass guest handlers')}finally{seen.dispose()}
    console.log(name+': native termination bypasses guest handlers')
  }finally{context.dispose();runtime.dispose()}
}
