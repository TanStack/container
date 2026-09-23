import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync} from 'node:fs'
import {resolve,join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {pathToFileURL} from 'node:url'
import workerModule from 'node:worker_threads'
import {traceWorkerProtocol} from '../tests/fixtures/worker-protocol-trace.mjs'

const fixture=resolve('fixtures/start-vite8-wasm')
const binding=join(fixture,'node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs')
const asyncWorkers=process.env.NAPI_RS_ASYNC_WORK_POOL_SIZE
const tracePool=process.env.START_TRACE_POOL==='1'
const traceImmediates=process.env.START_TRACE_IMMEDIATES==='1'
if(asyncWorkers!==undefined&&!/^[1-4]$/.test(asyncWorkers))throw Error('Expected async pool size 1 through 4')
if(!process.argv.includes('--child')){
  const child=spawnSync(process.execPath,[process.argv[1],'--child'],{
    env:{...process.env,NAPI_RS_NATIVE_LIBRARY_PATH:binding},encoding:'utf8',timeout:20000,maxBuffer:2*1024*1024,
  })
  const report={binding,asyncWorkers:asyncWorkers??'package default',status:child.status,signal:child.signal,error:child.error?.message,stdout:child.stdout,stderr:child.stderr}
  const reportPath='reports/native-start-workers'+(asyncWorkers?'-pool'+asyncWorkers:'')+(tracePool?'-pool-trace':'')+(traceImmediates?'-immediates':'')+'.json'
  writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify({reportPath,status:report.status,error:report.error}))
  process.exitCode=child.status===0?0:1
}else{
  const root=mkdtempSync(join(tmpdir(),'native-start-workers-'))
  symlinkSync(join(fixture,'node_modules'),join(root,'node_modules'),'dir')
  writeFileSync(join(root,'package.json'),'{"type":"module"}')
  for(const name of ['vite.config.ts','src/router.tsx','src/routes/__root.tsx','src/routes/index.tsx','src/routes/about.tsx']){
    mkdirSync(dirname(join(root,name)),{recursive:true})
    writeFileSync(join(root,name),readFileSync(join('fixtures/start-basic',name)))
  }
  const started=performance.now(),events=[],active=new Map()
  let peakActive=0,totalProtocolEvents=0,workersObserved=0,server
  const record=row=>{if(events.length<256)events.push({...row,ms:Math.round(performance.now()-started)})}
  traceWorkerProtocol(workerModule,row=>record({...row,active:active.size}),192,['load','loaded','start','spawn-thread','cleanup-thread'],row=>{
    totalProtocolEvents++
    workersObserved=Math.max(workersObserved,row.worker??0)
    if(row.direction==='send'&&row.type==='start')active.set(row.worker,row.tid)
    if(row.direction==='receive'&&row.type==='cleanup-thread'&&active.get(row.worker)===row.tid)active.delete(row.worker)
    peakActive=Math.max(peakActive,active.size)
  })
  const evidence={root,scope:'Native Node, same installed WASM binding and app source; native scheduling and memory, not sandbox limit parity',responses:[],events}
  let currentImmediate=0
  const recentImmediates=[]
  if(traceImmediates){
    const original=globalThis.setImmediate
    let nextImmediate=0,total=0
    evidence.immediates=[]
    evidence.recentImmediates=recentImmediates
    const log=row=>{const event={sequence:++total,ms:performance.now()-started,...row};recentImmediates.push(event);if(recentImmediates.length>64)recentImmediates.shift();if(evidence.immediates.length<1024)evidence.immediates.push(event);evidence.immediateDropped=Math.max(0,total-1024)}
    globalThis.setImmediate=function(callback,...args){
      if(typeof callback!=='function')return Reflect.apply(original,this,[callback,...args])
      const id=++nextImmediate,parent=currentImmediate,stack=String(new Error().stack).split('\n')
      log({phase:'queued',id,parent,caller:stack.slice(2,5).join('\n').slice(0,600),tail:stack.slice(-3).join('\n').slice(0,400)})
      return Reflect.apply(original,this,[function(...values){const previous=currentImmediate;currentImmediate=id;log({phase:'begin',id,parent});try{return Reflect.apply(callback,this,values)}finally{log({phase:'end',id,parent});currentImmediate=previous}},...args])
    }
  }
  if(tracePool){
    const {ThreadManager}=await import(pathToFileURL(join(fixture,'node_modules/@emnapi/wasi-threads/dist/wasi-threads.js')).href)
    const ids=new WeakMap();let nextId=0,poolEvents=0
    const identity=worker=>{if(!worker)return undefined;if(!ids.has(worker))ids.set(worker,++nextId);return ids.get(worker)}
    const snapshot=pool=>({idle:pool.unusedWorkers.length,active:Object.keys(pool.pthreads).length})
    evidence.pool=[];evidence.poolAllocations=[];evidence.poolTotals={get:0,returns:0,allocations:0,throws:0}
    for(const method of ['getNewWorker','returnWorkerToPool']){
      const original=ThreadManager.prototype[method]
      if(typeof original!=='function')throw Error('Missing worker pool method '+method)
      ThreadManager.prototype[method]=function(...args){
        const allocation=method==='getNewWorker'&&this.unusedWorkers.length===0,before=snapshot(this)
        evidence.poolTotals[method==='getNewWorker'?'get':'returns']++
        if(allocation)evidence.poolTotals.allocations++
        const record=row=>{poolEvents++;const event={immediate:currentImmediate,method,allocation,before,after:snapshot(this),ms:performance.now()-started,...row};if(evidence.pool.length<96)evidence.pool.push(event);if(allocation&&evidence.poolAllocations.length<16){const stack=new Error('allocation caller').stack;evidence.poolAllocations.push({...event,recentImmediates:recentImmediates.slice(-48),caller:stack?.slice(0,2000),callerTail:stack?.split('\n').slice(-8).join('\n').slice(0,1600)})}evidence.poolDropped=Math.max(0,poolEvents-96);evidence.poolAllocationsDropped=Math.max(0,evidence.poolTotals.allocations-16)}
        try{const result=Reflect.apply(original,this,args);record({phase:'return',worker:identity(method==='getNewWorker'?result:args[0])});return result}
        catch(error){evidence.poolTotals.throws++;record({phase:'throw'});throw error}
      }
    }
  }
  const deadline=setTimeout(()=>{console.log(JSON.stringify({...evidence,peakActive,failure:'15-second workflow deadline'}));process.exit(1)},15000)
  try{
    const {createServer}=await import(pathToFileURL(join(fixture,'node_modules/vite/dist/node/index.js')).href)
    server=await createServer({root,logLevel:'silent',server:{host:'127.0.0.1',port:0}})
    await server.listen();record({phase:'listening'})
    const port=server.httpServer.address().port
    for(const path of ['/','/about']){
      record({phase:'request',path})
      const response=await fetch(`http://127.0.0.1:${port}${path}`)
      const html=await response.text()
      evidence.responses.push({path,status:response.status,expectedContent:html.includes(path==='/'?'Bare-bones Start':'Second route')})
      if(response.status!==200||!evidence.responses.at(-1).expectedContent)throw Error('Unexpected SSR response')
      record({phase:'response',path})
    }
  }catch(error){evidence.failure={name:error.name,message:error.message,stack:error.stack}}
  finally{if(server)await server.close();clearTimeout(deadline)}
  process.stdout.write(JSON.stringify({...evidence,peakObservedActive:peakActive,workersObserved,activeAtCaptureEnd:[...active],totalProtocolEvents,summaryCoversFullRun:true,captureLimit:192,captureMayBeTruncated:totalProtocolEvents>192})+'\n',()=>process.exit(evidence.failure?1:0))
}
