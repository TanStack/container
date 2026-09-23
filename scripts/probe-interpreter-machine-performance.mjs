import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'

const roots=(process.env.INTERPRETER_PERF_ENGINES??'').split(':').filter(Boolean).map(root=>resolve(root))
if(roots.length!==2)throw Error('Set INTERPRETER_PERF_ENGINES to the matched control and candidate directories')
const cycles=Number(process.env.INTERPRETER_PERF_CYCLES??3)
const iterations=Number(process.env.INTERPRETER_PERF_ITERATIONS??5_000_000)
if(!Number.isInteger(cycles)||cycles<1||cycles>10)throw Error('INTERPRETER_PERF_CYCLES must be from 1 through 10')
if(!Number.isInteger(iterations)||iterations<1||iterations>20_000_000)throw Error('INTERPRETER_PERF_ITERATIONS must be from 1 through 20,000,000')

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex')
const source=`()=>{let total=0;for(let i=0;i<${iterations};i++)total=(total+(i%97))%1000000007;return total}`
const expected=iterations===5_000_000?239998879:null
const report={format:1,scope:'Node-hosted QuickJS arithmetic diagnostic only',cycles,iterations,engines:[]}

for(const root of roots){
  const wasm=readFileSync(join(root,'engine.wasm'))
  const core=await import(pathToFileURL(join(root,'core.mjs')).href)
  const {default:factory}=await import(pathToFileURL(join(root,'engine.mjs')).href)
  const {QuickJSAsyncFFI}=await import(pathToFileURL(join(root,'ffi.mjs')).href)
  const engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>QuickJSAsyncFFI,importModuleLoader:async()=>async()=>factory({wasmBinary:wasm})})
  const measurements=[]
  for(let cycle=0;cycle<cycles+1;cycle++){
    const runtime=engine.newRuntime(),context=runtime.newContext()
    runtime.setMemoryLimit(64*1024*1024);runtime.setMaxStackSize(256*1024)
    const deadline=Date.now()+60_000
    runtime.setInterruptHandler(()=>Date.now()>deadline)
    let fiber
    try{
      const fn=context.unwrapResult(context.evalCode(source))
      try{fiber=context.startFiberCall(fn)}finally{fn.dispose()}
      const start=performance.now(),status=fiber.step(),durationMs=performance.now()-start
      if(status!==2)throw Error(`Unexpected fiber status ${status}`)
      const result=fiber.takeResult()
      try{
        const value=context.dump(context.unwrapResult(result))
        if(expected!==null&&value!==expected)throw Error(`Unexpected arithmetic result ${value}`)
        if(cycle>0)measurements.push({cycle,durationMs,value})
      }finally{result.dispose()}
    }finally{fiber?.dispose();context.dispose();runtime.dispose()}
  }
  report.engines.push({root,wasmBytes:wasm.length,wasmSHA256:sha256(wasm),measurements,meanMs:measurements.reduce((sum,item)=>sum+item.durationMs,0)/measurements.length})
}
report.ratio=report.engines[1].meanMs/report.engines[0].meanMs
console.log(JSON.stringify(report,null,2))
