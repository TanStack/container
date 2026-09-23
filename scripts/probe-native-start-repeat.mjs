import {spawnSync} from 'node:child_process'
import {writeFileSync} from 'node:fs'
import {resolve} from 'node:path'

// Repeat the same ordinary app workflow. Do not increase workload or limits.
const binding=resolve('fixtures/start-vite8-wasm/node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs')
const runs=[]
for(let repeat=0;repeat<3;repeat++){
  const started=performance.now()
  const child=spawnSync(process.execPath,['scripts/probe-native-start-workers.mjs','--child'],{
    env:{...process.env,NAPI_RS_NATIVE_LIBRARY_PATH:binding,NAPI_RS_ASYNC_WORK_POOL_SIZE:'1',START_TRACE_POOL:'1',START_TRACE_IMMEDIATES:'0'},
    encoding:'utf8',timeout:20000,maxBuffer:2*1024*1024,
  })
  let evidence,parseError
  try{evidence=JSON.parse(child.stdout.trim())}catch(error){parseError=error.message}
  const row={repeat:repeat+1,status:child.status,signal:child.signal,error:child.error?.message,parseError,
    elapsedMs:Math.round(performance.now()-started),workersObserved:evidence?.workersObserved,
    peakObservedActive:evidence?.peakObservedActive,poolTotals:evidence?.poolTotals,
    responses:evidence?.responses,failure:evidence?.failure,stderr:child.stderr.slice(-4096)}
  runs.push(row)
  console.log(JSON.stringify({...row,stderr:undefined}))
}
const passed=runs.every(run=>run.status===0&&!run.parseError&&!run.failure&&run.responses?.length===2&&run.responses.every(response=>response.status===200&&response.expectedContent))
const report={scope:'Three repetitions of the unchanged native Start app with supported async pool one. No guest parity or sandbox memory claim.',node:process.version,binding,tracePool:true,traceImmediates:false,passed,runs}
writeFileSync('reports/native-start-repeat-pool1.json',JSON.stringify(report,null,2)+'\n')
if(!passed)process.exitCode=1
