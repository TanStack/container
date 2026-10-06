import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {lstatSync,mkdtempSync,readFileSync,realpathSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {siteRepeatInputs,siteRepeatOptions} from './repeat-local-native-site.mjs'
import {runNativeWorkflowChild} from './probe-native-owner-workflows.mjs'
import {nativeSiteExampleIds} from './native-site-project-inputs.mjs'
export {verifyNativeSiteProject as terminalMatrixProject} from './native-site-project-inputs.mjs'

const root=fileURLToPath(new URL('..',import.meta.url))
const examples=nativeSiteExampleIds
const browsers=['chromium','firefox','webkit']
const driver='scripts/test-local-native-terminal-examples.mjs'
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex')
const milestone=(browser,example)=>`${browser}: ${example} run 1/1 terminal, input, interrupt, failures, editor, live preview edit, build, resize, reopen, restart passed`

export function terminalMatrixOptions(args){
  for(let index=3;index<args.length;index+=2)
    assert.ok(['--site','--preview','--runner'].includes(args[index]),'The matrix always requires all four examples and three browsers')
  return siteRepeatOptions([...args,'--browser','all','--runs','1'])
}

export function terminalMatrixPlan(){
  return browsers.flatMap(browser=>examples.map(example=>({browser,example})))
}

export function terminalMatrixRunner(runnerMetadata,projectRoot=root){
  for(const metadata of Object.values(runnerMetadata.packages))
    assert.equal(metadata.version,'1.63.0','Use the pinned private browser runner')
  const runner=runnerMetadata.directory
  const paths=[driver,'scripts/native-terminal-viewport.mjs','scripts/native-edited-preview.mjs']
  const terminalHashes=Object.fromEntries(paths.map(path=>{
    const copied=join(runner,path),stat=lstatSync(copied)
    assert.ok(stat.isFile()&&!stat.isSymbolicLink(),'Terminal runner must be a regular file')
    const digest=hash(copied)
    assert.equal(digest,hash(join(projectRoot,path)),'Terminal runner source differs: '+path)
    return [path,digest]
  }))
  // A source-only runner can share an existing locked dependency directory.
  // Bind its actual dependency lock, not an unrelated lock copied beside it.
  const dependencyRoot=dirname(realpathSync(join(runner,'node_modules')))
  const lockPath=join(dependencyRoot,'package-lock.json')
  const lock=JSON.parse(readFileSync(lockPath))
  for(const name of ['@playwright/test','playwright','playwright-core'])
    assert.equal(lock.packages?.['node_modules/'+name]?.version,'1.63.0','Browser runner lock differs')
  return {terminalHashes,dependencyRoot,runnerLockSHA256:hash(lockPath),
    browserCatalogSHA256:hash(join(runner,'node_modules/playwright-core/browsers.json')),entrypoint:join(runner,driver)}
}

export function terminalMatrixInputs(options,projectRoot=root){
  const inputs=siteRepeatInputs(options,projectRoot)
  const runner=terminalMatrixRunner(inputs.runner,projectRoot)
  return {...inputs,...runner,driverSHA256:hash(fileURLToPath(import.meta.url))}
}

export function terminalMatrixOutcome(child,browser,example){
  const output=String(child.stdout??'')+'\n'+String(child.stderr??'')
  const milestones=output.split('\n').filter(line=>line.endsWith('resize, reopen, restart passed'))
  const complete=milestones.length===1&&milestones[0]===milestone(browser,example)
  return {output,complete,passed:child.status===0&&!child.error&&!child.signal&&complete}
}

// A failed example stays failed. Each later example gets a fresh browser
// process, so one expected build failure cannot hide untested matrix cells.
export async function runTerminalMatrix(options,{projectRoot=root,inputs=terminalMatrixInputs,
  run=runNativeWorkflowChild,env=process.env,signal}={}){
  const identity=inputs(options,projectRoot)
  const output=mkdtempSync(join(tmpdir(),'native-site-terminal-matrix-'))
  const plan=terminalMatrixPlan(),controller=new AbortController()
  const receipt={scope:'Original real-site terminal and production-build checks. Host page errors are diagnostic only, not error-free host acceptance.',
    identity,output,plan,rows:[],complete:false,passed:false}
  const save=()=>writeFileSync(join(output,'results.json'),JSON.stringify(receipt,null,2)+'\n')
  const abort=()=>controller.abort(signal.reason??Error('Matrix cancelled'))
  signal?.addEventListener('abort',abort,{once:true})
  if(signal?.aborted)abort()
  console.log('NATIVE_TERMINAL_MATRIX_REPORT '+join(output,'results.json'));save()
  try{
    for(const cell of plan){
      if(controller.signal.aborted){receipt.interrupted=String(controller.signal.reason);break}
      const basename=cell.browser+'-'+cell.example
      const childEnv=Object.fromEntries(Object.entries(env).filter(([key])=>!key.startsWith('NATIVE_')&&!key.startsWith('LOCAL_NATIVE_')))
      const failureReport=join(output,basename+'-failure.json'),failureCapture=join(output,basename+'-failure.png')
      Object.assign(childEnv,{NATIVE_SITE_ORIGIN:options.site,NATIVE_PREVIEW_ORIGIN:options.preview,
        NATIVE_BROWSER:cell.browser,NATIVE_EXAMPLES:cell.example,NATIVE_EXAMPLE_REPETITIONS:'1',
        NATIVE_FAILURE_REPORT:failureReport,NATIVE_FAILURE_CAPTURE:failureCapture})
      console.log('NATIVE_TERMINAL_MATRIX_START '+JSON.stringify(cell))
      const started=performance.now()
      const child=await run(process.execPath,[identity.entrypoint],{cwd:identity.runner.directory,env:childEnv},
        {signal:controller.signal,timeout:15*60*1000,maxBuffer:8*1024*1024})
      const result=terminalMatrixOutcome(child,cell.browser,cell.example)
      const log=join(output,basename+'.log')
      writeFileSync(log,result.output,{flag:'wx'})
      const row={...cell,status:child.status,signal:child.signal,error:child.error?String(child.error):undefined,
        elapsedMs:Math.round(performance.now()-started),complete:result.complete,passed:result.passed,
        log,failureReport,failureCapture}
      try{assert.deepEqual(inputs(options,projectRoot),identity,'Matrix inputs changed');row.inputsUnchanged=true}
      catch(error){row.inputError=String(error);row.passed=false}
      receipt.rows.push(row);save()
      console.log('NATIVE_TERMINAL_MATRIX_CELL '+JSON.stringify(row))
      if(row.inputError){receipt.stoppedReason='Matrix inputs changed';break}
    }
  }catch(error){receipt.runnerError=String(error)}
  finally{signal?.removeEventListener('abort',abort)}
  if(controller.signal.aborted)receipt.interrupted=String(controller.signal.reason)
  receipt.complete=receipt.rows.length===plan.length&&!receipt.runnerError&&!receipt.interrupted&&!receipt.stoppedReason
  receipt.passed=receipt.complete&&receipt.rows.every(row=>row.passed&&row.inputsUnchanged)
  save();return receipt
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const controller=new AbortController()
  const handlers=Object.fromEntries(['SIGINT','SIGTERM'].map(name=>[name,()=>controller.abort(Error(name))]))
  for(const [name,handler]of Object.entries(handlers))process.on(name,handler)
  try{
    const receipt=await runTerminalMatrix(terminalMatrixOptions(process.argv.slice(2)),{signal:controller.signal})
    if(!receipt.passed)process.exitCode=1
  }finally{for(const [name,handler]of Object.entries(handlers))process.removeListener(name,handler)}
}
