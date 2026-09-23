import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,existsSync,watch,copyFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {pathToFileURL,fileURLToPath} from 'node:url'
import {syncBuiltinESMExports} from 'node:module'
import workerModule from 'node:worker_threads'

const fixture=fileURLToPath(new URL('../fixtures/vite-rolldown-wasm',import.meta.url))
if(process.env.NAPI_RS_ASYNC_WORK_POOL_SIZE!==undefined||process.env.UV_THREADPOOL_SIZE!==undefined)throw Error('This control requires the package default async worker pool, without NAPI_RS_ASYNC_WORK_POOL_SIZE or UV_THREADPOOL_SIZE overrides')
const binding=join(fixture,'node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs')
const scope='Two fresh native Node processes using the installed WASM binding and one shared workspace/cache. HTTP request control only, not browser execution or HMR proof. Native memory is not sandbox budget parity.'
if(!process.argv.includes('--child')){
  const project=mkdtempSync(join(tmpdir(),'native-vite-resume-')),app=join(project,'app')
  mkdirSync(app)
  symlinkSync(join(fixture,'node_modules'),join(project,'node_modules'),'dir')
  writeFileSync(join(app,'index.html'),'<html><head><title>Agent Vite preview</title></head><body><button id="count"></button><p id="message"></p><script type="module" src="/main.ts"></script></body></html>')
  writeFileSync(join(app,'message.ts'),'export const message: string = "first version";')
  writeFileSync(join(app,'main.ts'),`import {message} from './message';let count: number=42;const button=document.querySelector('#count');button.textContent=String(count);button.onclick=()=>button.textContent=String(++count);document.querySelector('#message').textContent=message;if(import.meta.hot)import.meta.hot.accept('./message',next=>document.querySelector('#message').textContent=next.message);`)
  const rounds=[]
  for(const round of ['cold','warm']){
    const child=spawnSync(process.execPath,[process.argv[1],'--child',project,round],{cwd:project,env:{...process.env,NAPI_RS_NATIVE_LIBRARY_PATH:binding,DEBUG:'vite:deps'},encoding:'utf8',timeout:20000,maxBuffer:2*1024*1024})
    let observed
    try{observed=JSON.parse(child.stdout.trim().split('\n').at(-1))}catch{}
    const cacheAccepted=child.stderr?.includes('Hash is consistent. Skipping.')??false
    rounds.push({round,status:child.status,signal:child.signal,error:child.error?.message,cacheAccepted,observed,stdout:child.stdout,stderr:child.stderr})
    if(child.status!==0)break
  }
  mkdirSync(resolve('reports'),{recursive:true})
  const reportPath=resolve('reports/native-vite-resume.json')
  const priorReport=resolve('reports/native-vite-resume-before-cache-publication-wait.json')
  if(existsSync(reportPath)&&!existsSync(priorReport))copyFileSync(reportPath,priorReport)
  writeFileSync(reportPath,JSON.stringify({scope,project,binding,asyncWorkers:process.env.NAPI_RS_ASYNC_WORK_POOL_SIZE??'package default',rounds},null,2)+'\n')
  const passed=rounds.length===2&&rounds.every(row=>row.status===0)&&rounds[1].cacheAccepted
  console.log(JSON.stringify({reportPath,project,passed,workers:rounds.map(row=>({round:row.round,total:row.observed?.workerCreations}))}))
  process.exitCode=passed?0:1
}else{
  const project=process.argv[3],round=process.argv[4],app=join(project,'app')
  const started=performance.now(),events=[],responses=[]
  let workerCreations=0,active=0,peakActive=0,server,finished=false,cacheWatcher
  const cache=()=>{const path=join(server?.config.cacheDir??join(app,'.vite'),'deps/_metadata.json');return {path,exists:existsSync(path),...(existsSync(path)?{contents:readFileSync(path,'utf8').slice(0,8192)}:{})}}
  const beforeCache=cache(),OriginalWorker=workerModule.Worker
  workerModule.Worker=class extends OriginalWorker{
    constructor(...args){
      const id=++workerCreations
      if(events.length<96)events.push({phase:'create',id,ms:performance.now()-started,file:String(args[0]).slice(0,300)})
      super(...args);active++;peakActive=Math.max(peakActive,active)
      this.once('exit',code=>{active--;if(events.length<96)events.push({phase:'exit',id,code,ms:performance.now()-started})})
    }
  }
  syncBuiltinESMExports()
  const finish=failure=>{
    if(finished)return
    finished=true
    cacheWatcher?.close()
    process.stdout.write(JSON.stringify({scope,round,project,beforeCache,afterCache:cache(),responses,workerCreations,peakActive,active,events,failure,elapsedMs:performance.now()-started})+'\n',()=>process.exit(failure?1:0))
  }
  const deadline=setTimeout(()=>finish('15-second workflow deadline'),15000)
  let failure
  try{
    const {createServer}=await import(pathToFileURL(join(fixture,'node_modules/vite/dist/node/index.js')).href)
    server=await createServer({root:app,configFile:false,logLevel:'silent',server:{host:'127.0.0.1',port:0,strictPort:true}})
    const cachePublished=new Promise((resolve,reject)=>{
      if(cache().exists){resolve();return}
      const check=()=>{if(cache().exists)resolve()}
      cacheWatcher=watch(app,{recursive:true},check)
      cacheWatcher.on('error',reject)
      check()
    })
    await server.listen()
    const origin='http://127.0.0.1:'+server.httpServer.address().port
    // Sequential requests model the finite entry request surface, not browser scheduling.
    const request=async(path,content)=>{
      const response=await fetch(origin+path),body=await response.text()
      responses.push({path,status:response.status,contentMatched:body.includes(content),ms:performance.now()-started})
      if(response.status!==200||!body.includes(content))throw Error('Unexpected response for '+path)
    }
    await request('/','Agent Vite preview')
    await request('/@vite/client','WebSocket')
    await request('/main.ts','document.querySelector')
    await request('/message.ts',round==='cold'?'first version':'second version')
    if(round==='cold'){
      writeFileSync(join(app,'message.ts'),'export const message: string = "second version";')
      server.moduleGraph.invalidateAll()
      await request('/message.ts?t=1','second version')
    }
    // Wait for Vite's real optimizer completion, not an arbitrary timer.
    await server.environments.client.depsOptimizer?.scanProcessing
    await server.environments.client.waitForRequestsIdle()
    await cachePublished
  }catch(error){failure={name:error.name,message:error.message,stack:error.stack}}
  finally{cacheWatcher?.close();try{await server?.close()}catch(error){failure??={name:error.name,message:error.message}}clearTimeout(deadline)}
  if(!failure&&!cache().exists)failure={message:'Expected real optimizer metadata to persist'}
  finish(failure)
}
