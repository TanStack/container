import {readFileSync} from 'node:fs'
import ASYNCIFY from '@jitl/quickjs-wasmfile-release-asyncify'
const wasm=process.argv.includes('--wasm')
const directory='quickjs-als-asyncify'+(wasm?'-wasm':'')+'-cooperative'
const core=await import('../public/'+directory+'/core.mjs')
const {default:loader}=await import('../public/'+directory+'/engine.mjs')
const {QuickJSAsyncFFI}=await import('../public/'+directory+'/ffi.mjs')

const engine=await core.newQuickJSAsyncWASMModuleFromVariant(core.newVariant({
  ...ASYNCIFY,importModuleLoader:async()=>loader,importFFI:async()=>QuickJSAsyncFFI,
},{wasmBinary:readFileSync('public/'+directory+'/engine.wasm')}))
const runtime=engine.newRuntime(),context=runtime.newContext()
runtime.setMemoryLimit(32*1024*1024)
if(wasm)context.unwrapResult(await context.evalCodeAsync(readFileSync('src/sandbox/guest-wasm.js','utf8'),'wasm-bootstrap.js')).dispose()
let cancelled=false,ticks=0
const started=performance.now(),deadline=started+5000
runtime.setInterruptHandler(()=>cancelled||performance.now()>deadline)
const heartbeat=setInterval(()=>ticks++,5)
const cancel=setTimeout(()=>{cancelled=true},100)
try{
  const loop=[0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,7,8,1,4,108,111,111,112,0,0,10,9,1,7,0,3,64,12,0,11,11]
  if(!WebAssembly.validate(Uint8Array.from(loop)))throw Error('Invalid infinite-loop fixture')
  const result=await context.evalCodeAsync('globalThis.saved=41;'+(wasm?'new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array('+JSON.stringify(loop)+'))).exports.loop()':'while(true){}'),'cpu.js')
  const elapsedMs=performance.now()-started
  if(!result.error){result.value.dispose();throw Error('Infinite loop unexpectedly completed')}
  const error=context.dump(result.error);result.error.dispose()
  if(!cancelled||ticks<2||elapsedMs>1000)throw Error('Host event loop did not regain control: '+JSON.stringify({cancelled,ticks,elapsedMs,error}))
  cancelled=false
  const recovered=context.unwrapResult(await context.evalCodeAsync('saved+1','recovery.js'))
  const value=context.dump(recovered);recovered.dispose()
  if(value!==42)throw Error('Context did not survive interruption')
  console.log(JSON.stringify({wasm,cancelledLoop:true,ticks,elapsedMs,recovered:value,error},null,2))
}finally{clearInterval(heartbeat);clearTimeout(cancel);context.dispose();runtime.dispose()}
