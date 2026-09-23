import ASYNCIFY from '@jitl/quickjs-wasmfile-release-asyncify'
import wasmBootstrap from '../sandbox/guest-wasm.js?raw'
import {EngineAccess} from '../sandbox/engine-access'

async function loadCooperativeEngine(wasm:boolean){
  const base=new URL('/quickjs-als-asyncify'+(wasm?'-wasm':'')+'-cooperative/',location.href)
  const load=(file:string)=>import(/* @vite-ignore */new URL(file,base).href)
  const [core,loader,ffi]=await Promise.all([load('core.mjs'),load('engine.mjs'),load('ffi.mjs')])
  return core.newQuickJSAsyncWASMModuleFromVariant(core.newVariant({
    ...ASYNCIFY,importModuleLoader:async()=>loader.default,importFFI:async()=>ffi.QuickJSAsyncFFI,
  },{wasmLocation:new URL('engine.wasm',base).href}))
}

export async function probeCooperativeInterrupt(control?:{signal:AbortSignal;started:()=>void},wasm=false){
  const engine=await loadCooperativeEngine(wasm)
  const runtime=engine.newRuntime(),context=runtime.newContext()
  runtime.setMemoryLimit(32*1024*1024)
  if(wasm)context.unwrapResult(await context.evalCodeAsync(wasmBootstrap,'wasm-bootstrap.js')).dispose()
  const access=new EngineAccess()
  let completions=0,queuedWhileBusy=0
  let cancelled=false,ticks=0
  const started=performance.now(),deadline=started+5000
  runtime.setInterruptHandler(()=>cancelled||Boolean(control?.signal.aborted)||performance.now()>deadline)
  const heartbeat=setInterval(()=>{
    ticks++
    if(access.busy)queuedWhileBusy++
    access.enqueue(()=>{
      const value=context.newNumber(++completions)
      try{context.setProp(context.global,'completedHostCallbacks',value)}finally{value.dispose()}
    })
  },5)
  const cancel=control?undefined:setTimeout(()=>{cancelled=true},100)
  try{
    control?.started()
    const loop=[0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,7,8,1,4,108,111,111,112,0,0,10,9,1,7,0,3,64,12,0,11,11]
    const result=await access.run(()=>context.evalCodeAsync('globalThis.saved=41;'+(wasm?'new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array('+JSON.stringify(loop)+'))).exports.loop()':'while(true){}'),'cpu.js'))
    const elapsedMs=performance.now()-started
    if(!result.error){result.value.dispose();throw Error('Infinite loop unexpectedly completed')}
    const error=context.dump(result.error);result.error.dispose()
    if(!(cancelled||control?.signal.aborted)||ticks<2||elapsedMs>1000)throw Error('Event loop did not regain control: '+JSON.stringify({cancelled,ticks,elapsedMs,error}))
    cancelled=false
    runtime.setInterruptHandler(()=>performance.now()>deadline)
    clearInterval(heartbeat)
    if(completions!==0||queuedWhileBusy<2)throw Error('Completions were not deferred during execution')
    access.drain()
    if(completions!==ticks)throw Error('Host completions were lost')
    const recovered=context.unwrapResult(await access.run(()=>context.evalCodeAsync('saved+1','recovery.js')))
    const value=context.dump(recovered);recovered.dispose()
    if(value!==42)throw Error('Context did not survive interruption')
    return {wasm,ticks,completions,queuedWhileBusy,elapsedMs,recovered:value,error,crossOriginIsolated,hostSharedArrayBuffer:typeof SharedArrayBuffer}
  }finally{clearInterval(heartbeat);clearTimeout(cancel);access.close();context.dispose();runtime.dispose()}
}

export async function probeCooperativeCorpus(cases:Array<{name:string;code:string;expected:unknown}>,control:number[],md4:number[]){
  const engine=await loadCooperativeEngine(true)
  const rows=[]
  for(const fixture of cases){
    const runtime=engine.newRuntime(),context=runtime.newContext()
    runtime.setMemoryLimit(16*1024*1024);runtime.setMaxStackSize(512*1024)
    const deadline=performance.now()+5000
    runtime.setInterruptHandler(()=>performance.now()>deadline)
    try{
      context.unwrapResult(await context.evalCodeAsync(wasmBootstrap+';const control=new Uint8Array('+JSON.stringify(control)+');const md4=new Uint8Array('+JSON.stringify(md4)+');')).dispose()
      const result=await context.evalCodeAsync(fixture.code)
      const actual=context.dump(result.error??result.value)
      rows.push({name:fixture.name,passed:!result.error&&actual===fixture.expected,actual,expected:fixture.expected})
      result.dispose()
    }finally{context.dispose();runtime.dispose()}
  }
  return rows
}
