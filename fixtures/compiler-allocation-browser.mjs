import {newQuickJSWASMModuleFromVariant,newVariant} from 'quickjs-emscripten-core'
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync'

export async function probeCompilerAllocation(directory){
  if(!['quickjs-als','quickjs-als-wasm'].includes(directory))throw Error('Unknown engine')
  const loader=(await import(/* @vite-ignore */'/'+directory+'/engine.mjs')).default
  const bytes=await fetch('/'+directory+'/engine.wasm').then(r=>r.arrayBuffer())
  const engine=await newQuickJSWASMModuleFromVariant(newVariant({...RELEASE_SYNC,importModuleLoader:async()=>loader},{wasmBinary:bytes}))
  let failures=0,successes=0,recoveries=0
  for(let extra=0;extra<=65536;extra+=256){
    const runtime=engine.newRuntime(),ctx=runtime.newContext()
    let fn
    try{
      const init=ctx.evalCode(`globalThis.probe=()=>{const fn=Function('return arguments');const bound=fn.bind(null,42);return bound()[0]}`)
      if(init.error){const error=ctx.dump(init.error);init.error.dispose();throw Error(JSON.stringify(error))}
      init.value.dispose()
      fn=ctx.getProp(ctx.global,'probe')
      const usage=runtime.computeMemoryUsage(),usageValue=ctx.dump(usage),size=ctx.getProp(usage,'malloc_size'),base=ctx.getNumber(size);size.dispose();usage.dispose()
      if(!Number.isFinite(base))throw Error('Missing allocator usage: '+JSON.stringify(usageValue))
      const deadline=performance.now()+2000;runtime.setInterruptHandler(()=>performance.now()>deadline)
      runtime.setMemoryLimit(base+extra)
      const result=ctx.callFunction(fn,ctx.undefined)
      runtime.setMemoryLimit(16*1024*1024)
      if(result.error){failures++;result.error.dispose()}
      else{try{if(ctx.getNumber(result.value)!==42)throw Error('Wrong result')}finally{result.value.dispose()}successes++}
      const recovery=ctx.callFunction(fn,ctx.undefined)
      if(recovery.error){const error=ctx.dump(recovery.error);recovery.error.dispose();throw Error('Recovery: '+JSON.stringify(error))}
      try{if(ctx.getNumber(recovery.value)!==42)throw Error('Wrong recovery result')}finally{recovery.value.dispose()}
      recoveries++
    }finally{fn?.dispose();ctx.dispose();runtime.dispose()}
  }
  return {attempts:failures+successes,failures,successes,recoveries}
}
