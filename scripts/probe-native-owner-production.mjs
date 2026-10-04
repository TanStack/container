import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync,writeFileSync,mkdtempSync,realpathSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname,join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {nativeReleaseExamples} from './native-example-sources.mjs'
import {nativeReleaseAcceptanceIdentity,nativeReleaseAcceptancePlan} from './native-release-acceptance.mjs'
import {runNativeWorkflowChild} from './probe-native-owner-workflows.mjs'

const expectedNames=['TanStack Start counter','TanStack Start basic','TanStack Start streaming',
  'TanStack Router file-based SSR','Solid Start counter']
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex')

export function productionMatrixPlan(options){
  return nativeReleaseAcceptancePlan(options).flatMap(entry=>nativeReleaseExamples.map((example,index)=>({
    ...entry,example:expectedNames[index],fixture:example.fixture,
    options:{...entry.options,env:{...entry.options.env,
      NATIVE_OWNER_PRODUCTION:'1',NATIVE_OWNER_EXAMPLE:example.kind+'/'+example.path}},
  })))
}

export function productionMatrixOutcome(child,cell){
  const output=String(child.stdout??'')+'\n'+String(child.stderr??'')
  const rows=output.split('\n').flatMap(line=>{
    try{const row=JSON.parse(line);return Object.hasOwn(row,'development')?[row]:[]}catch{return []}
  })
  let observationError
  try{
    assert.equal(rows.length,1,'Each production cell must complete exactly one example')
    assert.deepEqual(rows[0],{browser:cell.browser,example:cell.example,development:'passed',
      restart:'not requested',productionBuild:'declared-script API',production:'passed'},
    'The declared build, development and production assertions must all complete')
  }catch(error){observationError=String(error)}
  return {output,observations:rows,observationError,
    passed:child.status===0&&!child.error&&!child.signal&&!observationError}
}

export function productionMatrixIdentity({root,sdk,deployment}){
  const acceptance=nativeReleaseAcceptanceIdentity(root,sdk,deployment)
  const require=createRequire(join(root,'package.json'))
  const dependencyRoot=dirname(realpathSync(join(root,'node_modules')))
  const lockPath=join(dependencyRoot,'package-lock.json'),lock=JSON.parse(readFileSync(lockPath))
  for(const name of ['@playwright/test','playwright','playwright-core']){
    assert.equal(require(name+'/package.json').version,'1.63.0','Pin the private desktop runner')
    assert.equal(lock.packages?.['node_modules/'+name]?.version,'1.63.0','Actual runner lock differs')
  }
  const core=dirname(require.resolve('playwright-core/package.json'))
  return {acceptance,node:process.version,dependencyRoot,runnerLockSHA256:hash(lockPath),
    browserCatalogSHA256:hash(join(core,'browsers.json')),
    driverSHA256:hash(fileURLToPath(import.meta.url))}
}

// The existing three-minute deadline applies to each original test process.
// A failed cell stays failed. All fifteen cells remain in the required plan.
export async function probeNativeOwnerProduction(options,{run=runNativeWorkflowChild,
  inputs=productionMatrixIdentity,signal}={}){
  const identity=inputs(options),plan=productionMatrixPlan(options)
  const output=mkdtempSync(join(tmpdir(),'native-owner-production-'))
  const receipt={scope:'All five pinned examples in three engines, declared build-script API, production checkpoint restore, preview hydration and both progressive streams. Not terminal CLI, full-site or publication acceptance.',
    identity,output,concurrency:2,plan:plan.map(({browser,example,fixture})=>({browser,example,fixture})),
    rows:[],complete:false,passed:false}
  const controller=new AbortController(),rows=[]
  let next=0
  const save=()=>{
    receipt.rows=rows.filter(Boolean)
    writeFileSync(join(output,'results.json'),JSON.stringify(receipt,null,2)+'\n')
  }
  const abort=()=>controller.abort(signal.reason??Error('Production matrix cancelled'))
  signal?.addEventListener('abort',abort,{once:true})
  if(signal?.aborted)abort()
  console.log('NATIVE_OWNER_PRODUCTION_REPORT '+join(output,'results.json'));save()
  try{
    const settled=await Promise.allSettled(Array.from({length:2},async()=>{
      while(next<plan.length&&!controller.signal.aborted){
        const index=next++,cell=plan[index],started=performance.now()
        console.log('NATIVE_OWNER_PRODUCTION_START '+JSON.stringify({browser:cell.browser,example:cell.example}))
        const child=await run(cell.command,cell.args,cell.options,
          {signal:controller.signal,timeout:185000,maxBuffer:16*1024*1024})
        const result=productionMatrixOutcome(child,cell)
        const log=join(output,cell.browser+'-'+cell.fixture+'.log')
        writeFileSync(log,result.output,{flag:'wx'})
        const row={browser:cell.browser,example:cell.example,fixture:cell.fixture,
          status:child.status,signal:child.signal,error:child.error?String(child.error):undefined,
          elapsedMs:Math.round(performance.now()-started),log,
          observations:result.observations,observationError:result.observationError,passed:result.passed}
        try{assert.deepEqual(inputs(options),identity,'Production inputs changed');row.inputsUnchanged=true}
        catch(error){row.inputError=String(error);row.passed=false;controller.abort(error)}
        rows[index]=row;save()
        console.log('NATIVE_OWNER_PRODUCTION_CELL '+JSON.stringify(row))
      }
    }).map(worker=>worker.catch(error=>{controller.abort(error);throw error})))
    const rejected=settled.find(row=>row.status==='rejected')
    if(rejected)throw rejected.reason
  }catch(error){receipt.runnerError=String(error);controller.abort(error)}
  finally{signal?.removeEventListener('abort',abort)}
  if(controller.signal.aborted)receipt.interrupted=String(controller.signal.reason)
  receipt.complete=receipt.rows.length===plan.length&&!receipt.runnerError&&!receipt.interrupted
  receipt.passed=receipt.complete&&receipt.rows.every(row=>row.passed&&row.inputsUnchanged)
  save();return receipt
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.equal(process.argv.length,5,'Usage: node scripts/probe-native-owner-production.mjs EXAMPLE_CHECKOUT INSTALLED_SDK DEPLOYMENT')
  const [root,sdk,deployment]=process.argv.slice(2).map(value=>resolve(value))
  const controller=new AbortController()
  const handlers=Object.fromEntries(['SIGINT','SIGTERM'].map(name=>[name,()=>controller.abort(Error(name))]))
  for(const [name,handler]of Object.entries(handlers))process.on(name,handler)
  try{
    const receipt=await probeNativeOwnerProduction({root,sdk,deployment},{signal:controller.signal})
    if(!receipt.passed)process.exitCode=1
  }finally{for(const [name,handler]of Object.entries(handlers))process.removeListener(name,handler)}
}
