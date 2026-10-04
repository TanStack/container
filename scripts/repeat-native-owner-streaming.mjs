import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {nativeReleaseAcceptanceIdentity,nativeReleaseAcceptancePlan} from './native-release-acceptance.mjs'
import {nativeExampleHash} from './native-example-sources.mjs'

const root=fileURLToPath(new URL('..',import.meta.url))
export function ownerStreamRepeatOptions(args){
  const [sdk,deployment,...flags]=args
  assert.ok(sdk&&deployment&&!sdk.startsWith('--')&&!deployment.startsWith('--'),
    'Usage: node scripts/repeat-native-owner-streaming.mjs INSTALLED_SDK DEPLOYMENT [--runs 1..10] [--browser chromium|firefox|webkit]')
  assert.equal(flags.length%2,0,'Every repeat option requires a value')
  const options={sdk:resolve(sdk),deployment:resolve(deployment),runs:3,browser:'firefox'}
  const seen=new Set()
  for(let index=0;index<flags.length;index+=2){
    const name=flags[index]
    assert.ok(['--runs','--browser'].includes(name)&&!seen.has(name),'Unknown or repeated option: '+name)
    seen.add(name);options[name.slice(2)]=flags[index+1]
  }
  assert.ok(/^(?:[1-9]|10)$/.test(String(options.runs)),'Repeat count must be 1..10')
  options.runs=Number(options.runs)
  assert.ok(['chromium','firefox','webkit'].includes(options.browser),'Unknown browser')
  return options
}

export function runOwnerStreamRepeats(options,{projectRoot=root,run=spawnSync,
  identity=nativeReleaseAcceptanceIdentity,env=process.env}={}){
  const {sdk,deployment,browser,runs}=options
  const before=identity(projectRoot,sdk,deployment)
  const runnerSHA256=nativeExampleHash(readFileSync(new URL(import.meta.url)))
  const output=mkdtempSync(join(tmpdir(),'native-owner-stream-repeats-'))
  const plan=nativeReleaseAcceptancePlan({root:projectRoot,sdk,deployment,env}).find(item=>item.browser===browser)
  const rows=[]
  const expectedExamples=['TanStack Start counter','TanStack Start basic','TanStack Start streaming',
    'TanStack Router file-based SSR','Solid Start counter']
  for(let iteration=1;iteration<=runs;iteration++){
    console.log('NATIVE_STREAM_REPEAT_START '+JSON.stringify({iteration,runs,browser,output}))
    const started=performance.now()
    const child=run(plan.command,plan.args,{...plan.options,stdio:'pipe',encoding:'utf8',maxBuffer:16*1024*1024,
      env:{...plan.options.env,NATIVE_OWNER_STREAM_OBSERVE:'1'}})
    const log=String(child.stdout??'')+String(child.stderr??'')
    const logPath=join(output,`run-${iteration}.log`)
    writeFileSync(logPath,log,{flag:'wx'})
    assert.deepEqual(identity(projectRoot,sdk,deployment),before,'Repeat inputs changed')
    assert.equal(nativeExampleHash(readFileSync(new URL(import.meta.url))),runnerSHA256,'Repeat runner changed')
    let observations=[],parseError
    try{observations=log.split('\n').filter(line=>line.startsWith('NATIVE_STREAM_OBSERVATION '))
      .map(line=>JSON.parse(line.slice('NATIVE_STREAM_OBSERVATION '.length)))}
    catch(error){parseError=error.message}
    const examples=log.split('\n').filter(line=>line.startsWith('{')).flatMap(line=>{
      try{const value=JSON.parse(line);return value.development?[value]:[]}catch{return []}
    })
    const completeWorkflow=examples.length===expectedExamples.length&&expectedExamples.every(name=>
      examples.filter(item=>item.browser===browser&&item.example===name&&item.development==='passed').length===1)
    const row={iteration,browser,exitCode:child.status,signal:child.signal,error:child.error?.message,
      elapsedMs:Math.round(performance.now()-started),passed:child.status===0&&!child.error&&!parseError&&completeWorkflow&&
        observations.length===1&&Array.isArray(observations[0].frames)&&
        observations[0].frames.some(frame=>Array.isArray(frame.rows)&&frame.rows.length>0),
      examples,observations,parseError,log:logPath}
    rows.push(row)
    writeFileSync(join(output,`run-${iteration}.json`),JSON.stringify(row,null,2)+'\n',{flag:'wx'})
    console.log('NATIVE_STREAM_REPEAT '+JSON.stringify({...row,observations:undefined}))
  }
  const report={scope:'Repeated full five-example development and owner/terminal/agent workflow, passive streaming evidence, not full-site or production acceptance.',
    node:process.version,browser,runs,identity:before,runnerSHA256,output,rows,passed:rows.every(row=>row.passed)}
  writeFileSync(join(output,'results.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'})
  console.log('NATIVE_STREAM_REPEAT_REPORT '+join(output,'results.json'))
  return report
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const report=runOwnerStreamRepeats(ownerStreamRepeatOptions(process.argv.slice(2)))
  if(!report.passed)process.exitCode=1
}
