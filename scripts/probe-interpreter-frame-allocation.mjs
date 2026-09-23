import {readFileSync,writeFileSync} from 'node:fs'
import {newQuickJSWASMModuleFromVariant,newVariant} from 'quickjs-emscripten-core'
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync'

const rows=[]
for(const name of ['quickjs-als','quickjs-als-wasm']){
  const build=JSON.parse(readFileSync(`public/${name}/build.json`))
  if(!build.interpreterFrames)throw Error('Expected explicit interpreter-frame build')
  const loader=(await import(`../public/${name}/engine.mjs`)).default
  const engine=await newQuickJSWASMModuleFromVariant(newVariant({...RELEASE_SYNC,importModuleLoader:async()=>loader},{wasmBinary:readFileSync(`public/${name}/engine.wasm`)}))
  let failures=0,successes=0
  for(let headroom=0;headroom<=131072;headroom+=1024){
    const runtime=engine.newRuntime(),ctx=runtime.newContext()
    runtime.setMaxStackSize(512*1024)
    const fn=ctx.unwrapResult(ctx.evalCode('(function run(n){let x=n;const get=()=>x;if(n===0)return get;const result=run(n-1);x++;return result})'))
    const depth=ctx.newNumber(160)
    try{
      const usage=runtime.computeMemoryUsage(),used=ctx.dump(usage).malloc_size;usage.dispose()
      runtime.setMemoryLimit(used+headroom)
      const attempted=ctx.callFunction(fn,ctx.undefined,depth)
      runtime.setMemoryLimit(16*1024*1024)
      if(attempted.error){failures++;attempted.error.dispose()}
      else{successes++;attempted.value.dispose()}
      // Retry on the same runtime after allocation failure, including closure
      // creation and closing variable references while frames unwind.
      const result=ctx.unwrapResult(ctx.callFunction(fn,ctx.undefined,depth))
      const value=ctx.unwrapResult(ctx.callFunction(result,ctx.undefined))
      if(ctx.dump(value)!==0)throw Error('Incorrect retained closure')
      value.dispose();result.dispose()
    }finally{
      runtime.setMemoryLimit(16*1024*1024)
      depth.dispose();fn.dispose();ctx.dispose();runtime.dispose()
    }
  }
  if(!failures||!successes)throw Error('Allocation sweep must cover failures and successes')
  rows.push({name,build,failures,successes})
  console.log(name,JSON.stringify({failures,successes}))
}
writeFileSync('reports/interpreter-frame-allocation.json',JSON.stringify({scope:'WASM engines hosted in Node, allocation limits and same-runtime recovery, not native sanitizer coverage',rows},null,2)+'\n')
