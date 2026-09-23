import {readFile,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {newQuickJSWASMModuleFromVariant,newVariant} from 'quickjs-emscripten-core'
import SYNC from '@jitl/quickjs-wasmfile-release-sync'

const directory=resolve(process.argv[2]??'public/quickjs-als')
const label=process.argv[3]??'after'
if(!['before','after'].includes(label))throw Error('Expected before or after label')
const wasm=await readFile(resolve(directory,'engine.wasm'))
const loader=(await import(pathToFileURL(resolve(directory,'engine.mjs')).href)).default
const engine=await newQuickJSWASMModuleFromVariant(newVariant({...SYNC,importModuleLoader:async()=>loader},{wasmBinary:wasm}))
const results=[]
for(const code of [`import './missing.mjs'`,`await import('./missing.mjs')`,`import './parent.mjs'`]){
  const runtime=engine.newRuntime(),context=runtime.newContext(),loads=[]
  runtime.setModuleLoader(name=>{
    loads.push(name)
    if(name==='/parent.mjs')return `import './missing.mjs'`
    return {error:context.newError('Unexpected module load: '+name)}
  },(_base,name)=>name==='./parent.mjs'?'/parent.mjs':{error:context.newError('Expected resolution failure')})
  let error,recovered=false
  try{
    const result=context.evalCode(code,'/entry.mjs',{type:'module'})
    if(result.error){error=context.dump(result.error);result.dispose()}
    else{
      try{
        for(let index=0;index<20;index++){
          const jobs=runtime.executePendingJobs(100)
          if(jobs.error){error=context.dump(jobs.error);jobs.dispose();break}jobs.dispose()
          const state=context.getPromiseState(result.value)
          if(state.type==='rejected'){error=context.dump(state.error);state.error.dispose();break}
          if(state.type==='fulfilled'){if(!state.notAPromise)state.value.dispose();break}
        }
      }finally{result.dispose()}
    }
    const recovery=context.unwrapResult(context.evalCode('42'))
    recovered=context.getNumber(recovery)===42;recovery.dispose()
  }finally{context.dispose();runtime.dispose()}
  const passed=error?.message==='Expected resolution failure'&&loads.every(name=>name==='/parent.mjs')&&recovered
  results.push({code,passed,error,loads,recovered})
}
await writeFile('reports/module-normalizer-'+label+'.json',JSON.stringify({wasmSHA256:createHash('sha256').update(wasm).digest('hex'),results},null,2)+'\n')
console.log(JSON.stringify(results,null,2))
if(results.some(row=>!row.passed))process.exitCode=1
