import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {readFileSync,writeFileSync,mkdtempSync,existsSync} from 'node:fs'
import {createRequire} from 'node:module'
import {tmpdir} from 'node:os'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {nativeReleaseAcceptanceIdentity,nativeReleaseAcceptancePlan} from './native-release-acceptance.mjs'
import {verifySourceSnapshot} from './source-snapshot.mjs'

const expectedExamples=['TanStack Start counter','TanStack Start basic','TanStack Start streaming',
  'TanStack Router file-based SSR','Solid Start counter']

export function verifyNativeCallbackInput(inventory,engine){
  assert.equal(inventory?.diagnostics?.vitePrivateCallbackTrace,true,'Callback mode requires an instrumented diagnostic build')
  for(const marker of ['finishPrivateImport','observePrivateImport','privateImportOutcome'])
    assert.ok(engine.includes(marker),'Callback transform is absent from the engine: '+marker)
}

export function verifyNativeFilesystemInput(inventory,engine){
  assert.equal(inventory?.diagnostics?.wasiFilesystemReplyTrace,true,'Filesystem mode requires a diagnostic build')
  assert.ok(engine.includes('wasi-fs-reply:'),'Filesystem trace is absent from the engine')
}

export function verifyNativeOwnerWorkflow(output,browser){
  assert.ok(['chromium','firefox','webkit'].includes(browser),'Unsupported workflow browser')
  const rows=String(output).split('\n').flatMap(line=>{
    try{const row=JSON.parse(line);return Object.hasOwn(row,'development')?[row]:[]}catch{return []}
  })
  assert.equal(rows.length,5,'Workflow must complete all five examples')
  for(const name of expectedExamples)
    assert.equal(rows.filter(row=>row.browser===browser&&row.example===name&&row.development==='passed').length,1,
      'Missing, duplicate or failed example: '+name)
  return rows
}

export function nativeWorkflowConcurrency(mode,value=1){
  assert.ok(Number.isInteger(value)&&value>=1&&value<=3,'Concurrency must be an integer from 1 to 3')
  return mode==='desktop'?value:1
}

// Drain every started child before returning, including siblings cancelled after failure.
export async function scheduleNativeWorkflows(plans,{concurrency=1,run,signal}={}){
  nativeWorkflowConcurrency('desktop',concurrency)
  const controller=new AbortController(),rows=[]
  let next=0,failed=false
  const abort=()=>{failed=true;controller.abort(signal?.reason)}
  signal?.addEventListener('abort',abort,{once:true})
  if(signal?.aborted)abort()
  try{
    const settled=await Promise.allSettled(Array.from({length:Math.min(concurrency,plans.length)},async()=>{
      while(!failed&&next<plans.length){
        const index=next++
        let row
        try{row=await run(plans[index],index,controller.signal)}
        catch(error){failed=true;controller.abort(error);throw error}
        rows[index]=row
        if(!row.passed){failed=true;controller.abort(Error('Workflow sibling failed'))}
      }
    }))
    const rejected=settled.find(item=>item.status==='rejected')
    if(rejected)throw rejected.reason
  }finally{signal?.removeEventListener('abort',abort)}
  return rows.filter(Boolean)
}

export function runNativeWorkflowChild(command,args,options,{signal,timeout=240000,maxBuffer=16*1024*1024,killGraceMs=1000}={}){
  return new Promise(resolve=>{
    let child,error,stdout=[],stderr=[],size=0,killTimer
    const grouped=process.platform!=='win32'
    const kill=signalName=>{
      try{if(grouped)process.kill(-child.pid,signalName);else child.kill(signalName)}
      catch(cause){if(cause.code!=='ESRCH')error??=cause}
    }
    const stop=cause=>{
      error??=cause
      kill('SIGTERM')
      killTimer??=setTimeout(()=>kill('SIGKILL'),killGraceMs)
    }
    try{child=spawn(command,args,{...options,stdio:['ignore','pipe','pipe'],detached:grouped})}
    catch(cause){resolve({status:null,signal:null,error:cause,stdout:'',stderr:''});return}
    const collect=target=>chunk=>{
      const available=Math.max(0,maxBuffer-size)
      target.push(chunk.subarray(0,available));size+=chunk.length
      if(size>maxBuffer)stop(Error('Workflow output exceeded maxBuffer'))
    }
    child.stdout.on('data',collect(stdout));child.stderr.on('data',collect(stderr))
    child.on('error',cause=>{error??=cause})
    const abort=()=>stop(signal.reason??Error('Workflow cancelled'))
    signal?.addEventListener('abort',abort,{once:true})
    const timer=setTimeout(()=>stop(Error('Workflow child timed out')),timeout)
    if(signal?.aborted)abort()
    child.on('close',(status,childSignal)=>{
      clearTimeout(timer);clearTimeout(killTimer)
      // A force-exited Node test can leave browser descendants in its process group.
      if(grouped)kill('SIGKILL')
      signal?.removeEventListener('abort',abort)
      resolve({status,signal:childSignal,error,stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8')})
    })
  })
}

export async function probeNativeOwnerWorkflows(sdk,deployment,runnerRoot,sourceArchive,{mode='desktop',concurrency=1}={}){
  const limit=nativeWorkflowConcurrency(mode,concurrency),startedAt=Date.now()
  assert.ok(['desktop','repeat-desktop','callbacks','filesystem','interactions','listeners','repeat-listeners'].includes(mode),'Unknown workflow mode')
  const root=fileURLToPath(new URL('..',import.meta.url))
  sdk=resolve(sdk);deployment=resolve(deployment);runnerRoot=resolve(runnerRoot);sourceArchive=resolve(sourceArchive)
  const require=createRequire(join(runnerRoot,'package.json'))
  const core=dirname(require.resolve('playwright-core/package.json'))
  const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex')
  const copiedPaths=['tests/native-owner-sdk.test.mjs','tests/native-fetch-consumption-browser.test.mjs',
    ...['acceptance-failures','safari-install-stage-trace','native-example-sources','sdk-browser-assets',
      'native-stream-observation','native-owner-startup-observation','native-fetch-consumption-observation',
      'native-worker-io-observation','native-preview-interaction-observation','native-preview-click-listener-observation'].map(name=>'scripts/'+name+'.mjs')]
  const identity=()=>{
    for(const name of ['@playwright/test','playwright','playwright-core'])
      assert.equal(require(name+'/package.json').version,'1.63.0','Pin the private browser runner')
    const copied=Object.fromEntries(copiedPaths.map(path=>{
      const digest=hash(join(root,path));assert.equal(hash(join(runnerRoot,path)),digest,'Copied runner changed: '+path)
      return [path,digest]
    }))
    const browsers=Object.fromEntries(['chromium','firefox','webkit'].map(name=>{
      const executable=require('playwright')[name].executablePath()
      assert.ok(existsSync(executable),'Missing browser: '+name)
      return [name,executable]
    }))
    const acceptance=nativeReleaseAcceptanceIdentity(root,sdk,deployment)
    if(mode==='callbacks'||mode==='filesystem'){
      const sdkRequire=createRequire(join(sdk,'package.json'))
      const runtime=dirname(sdkRequire.resolve('@tanstack/browser-sandbox-runtime-experimental/setup'))
      const profile=JSON.parse(readFileSync(join(runtime,'runtime-profile.json')))
      const runtimes=profile.nativeRuntime.runtimes??[profile.nativeRuntime]
      for(const item of runtimes){
        const engine=join(runtime,item.entry)
        const inventory=JSON.parse(readFileSync(join(dirname(engine),'SHIPPED-INPUTS.json')))
        const source=readFileSync(engine,'utf8')
        if(mode==='callbacks')verifyNativeCallbackInput(inventory,source)
        else verifyNativeFilesystemInput(inventory,source)
      }
    }
    return {acceptance,copied,browsers,
      source:verifySourceSnapshot(root,sourceArchive),driverSHA256:hash(fileURLToPath(import.meta.url)),
      packageLockSHA256:hash(join(runnerRoot,'package-lock.json')),catalogSHA256:hash(join(core,'browsers.json')),
      node:process.version}
  }
  const before=identity(),directory=mkdtempSync(join(tmpdir(),'native-owner-workflows-'))
  const receipt={scope:'Complete pinned development workflows. Not production builds, real-site acceptance or alpha approval.',
    mode,concurrency:limit,identity:before,rows:[],passed:false}
  const save=()=>writeFileSync(join(directory,'results.json'),JSON.stringify(receipt,null,2)+'\n')
  console.log('Native owner workflow receipt: '+join(directory,'results.json'));save()
  const catalog=nativeReleaseAcceptancePlan({root,sdk,deployment})
  const listenerMode=mode==='listeners'||mode==='repeat-listeners'
  const plans=mode==='repeat-listeners'?[catalog[1],catalog[1],catalog[1]]:
    ['callbacks','filesystem','interactions','listeners'].includes(mode)?[catalog[1]]:mode==='repeat-desktop'?
    [catalog[1],catalog[0],catalog[1],catalog[2]]:catalog
  const controller=new AbortController()
  const interrupts=Object.fromEntries(['SIGINT','SIGTERM'].map(name=>[name,()=>{
    receipt.interrupted=name;controller.abort(Error('Workflow interrupted: '+name))
  }]))
  for(const [name,handler] of Object.entries(interrupts))process.on(name,handler)
  try{
  await scheduleNativeWorkflows(plans,{concurrency:limit,signal:controller.signal,run:async(plan,index,signal)=>{
    const args=plan.args.slice(0,-1).concat(join(runnerRoot,'tests/native-owner-sdk.test.mjs'))
    const started=Date.now(),observed=['callbacks','filesystem','interactions'].includes(mode)||listenerMode
    const child=await runNativeWorkflowChild(plan.command,args,{...plan.options,
      env:{...plan.options.env,NATIVE_OWNER_STARTUP_OBSERVE:observed?'1':'0',NATIVE_OWNER_FETCH_CONSUMPTION:'0',
        NATIVE_OWNER_MODULE_TRACE:'0',NATIVE_OWNER_VITE_REQUEST_TRACE:mode==='callbacks'?'callbacks':'0',
        NATIVE_OWNER_INTERACTION_OBSERVE:mode==='interactions'||listenerMode?'1':'0',
        NATIVE_OWNER_CLICK_LISTENER_OBSERVE:listenerMode?'1':'0',
        NATIVE_OWNER_TRACE:observed?'1':'0',NATIVE_OWNER_WORKER_IO:'0'}},{signal})
    const output=(child.stdout??'')+'\n'+(child.stderr??'')
    const log=join(directory,`run-${index+1}-${plan.browser}.log`)
    writeFileSync(log,output,{flag:'wx'})
    const row={browser:plan.browser,iteration:index+1,status:child.status,signal:child.signal,
      error:child.error?String(child.error):undefined,elapsedMs:Date.now()-started,log,passed:false}
    try{
      assert.equal(child.status,0);assert.equal(child.error,undefined)
      row.examples=verifyNativeOwnerWorkflow(output,plan.browser)
      assert.deepEqual(identity(),before,'Workflow inputs changed')
      row.inputsUnchanged=true;row.passed=true
    }catch(error){row.validationError=String(error)}
    receipt.rows.push(row);receipt.rows.sort((a,b)=>a.iteration-b.iteration);save()
    console.log(JSON.stringify({...row,examples:undefined}))
    return row
  }})
  }catch(error){receipt.runnerError=String(error)}
  finally{for(const [name,handler] of Object.entries(interrupts))process.removeListener(name,handler)}
  receipt.elapsedMs=Date.now()-startedAt
  try{assert.deepEqual(identity(),before);receipt.inputsUnchanged=true}catch(error){receipt.identityError=String(error)}
  receipt.passed=!receipt.interrupted&&!receipt.runnerError&&receipt.rows.length===plans.length&&receipt.rows.every(row=>row.passed)&&receipt.inputsUnchanged===true
  save();return {directory,result:receipt}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.ok(process.argv.length>=6&&process.argv.length<=8,
    'Usage: node scripts/probe-native-owner-workflows.mjs SDK DEPLOYMENT PRIVATE_RUNNER SOURCE_ARCHIVE [desktop|repeat-desktop|callbacks|filesystem|interactions|listeners|repeat-listeners] [CONCURRENCY:1-3]')
  const result=await probeNativeOwnerWorkflows(...process.argv.slice(2,6),{mode:process.argv[6]??'desktop',concurrency:process.argv[7]===undefined?1:Number(process.argv[7])})
  if(!result.result.passed)process.exitCode=1
}
