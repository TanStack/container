import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs'
import {dirname,join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {nativeReleaseAcceptanceIdentity,nativeReleaseAcceptancePlan} from './native-release-acceptance.mjs'
import {nativeExampleHash} from './native-example-sources.mjs'

const root=fileURLToPath(new URL('..',import.meta.url))
const browsers=['chromium','firefox','webkit']
const examples=['TanStack Start counter','TanStack Start basic','TanStack Start streaming',
  'TanStack Router file-based SSR','Solid Start counter']

export function nativeSDKRepeatOptions(args){
  const [sdk,deployment,...flags]=args
  assert.ok(sdk&&deployment&&!sdk.startsWith('--')&&!deployment.startsWith('--'),
    'Pass an installed SDK and prepared deployment')
  assert.equal(flags.length%2,0,'Pass option/value pairs')
  const options={sdk:resolve(sdk),deployment:resolve(deployment),runs:2,browser:'all'},seen=new Set()
  for(let index=0;index<flags.length;index+=2){
    const name=flags[index]
    assert.ok(['--runs','--browser'].includes(name)&&!seen.has(name),'Unknown or repeated option: '+name)
    seen.add(name);options[name.slice(2)]=flags[index+1]
  }
  assert.match(String(options.runs),/^[2-5]$/,'Repeat count must be 2..5')
  options.runs=Number(options.runs)
  assert.ok(['all',...browsers].includes(options.browser),'Unknown browser')
  return options
}

export function nativeSDKRepeatBrowserIdentity(projectRoot){
  const lockBytes=readFileSync(join(projectRoot,'package-lock.json')),lock=JSON.parse(lockBytes)
  const require=createRequire(join(projectRoot,'package.json')),installedVersions={}
  for(const name of ['@playwright/test','playwright','playwright-core']){
    const expected=lock.packages?.['node_modules/'+name]?.version
    assert.match(expected??'',/^\d+\.\d+\.\d+$/,'Browser runner needs a locked version: '+name)
    installedVersions[name]=require(name+'/package.json').version
    assert.equal(installedVersions[name],expected,'Installed browser runner differs from its lock: '+name)
  }
  return {runnerLockSHA256:nativeExampleHash(lockBytes),installedVersions,
    browserCatalogSHA256:nativeExampleHash(readFileSync(join(dirname(require.resolve('playwright-core/package.json')),'browsers.json')))}
}

export function nativeSDKRepeatIdentity(projectRoot,sdk,deployment){
  return {acceptance:nativeReleaseAcceptanceIdentity(projectRoot,sdk,deployment),...nativeSDKRepeatBrowserIdentity(projectRoot)}
}

export function nativeSDKRepeatOutcome(child,browser){
  const rows=[]
  let parseError
  for(const line of String(child.stdout??'').split('\n')){
    if(!line.startsWith('{'))continue
    try{const value=JSON.parse(line);if(value.development!==undefined)rows.push(value)}
    catch(error){parseError=String(error)}
  }
  const complete=rows.length===examples.length&&rows.every((row,index)=>
    row.browser===browser&&row.example===examples[index]&&row.development==='passed')
  return {complete,passed:child.status===0&&!child.signal&&!child.error&&!parseError&&complete,
    examples:rows,parseError}
}

export function runNativeSDKRepeats(options,{projectRoot=root,run=spawnSync,identity=nativeSDKRepeatIdentity,env=process.env}={}){
  assert.ok(Number.isInteger(options.runs)&&options.runs>=2&&options.runs<=5,'Repeat count must be 2..5')
  assert.ok(['all',...browsers].includes(options.browser),'Unknown browser')
  const before=identity(projectRoot,options.sdk,options.deployment)
  const driverSHA256=nativeExampleHash(readFileSync(fileURLToPath(import.meta.url)))
  const plans=nativeReleaseAcceptancePlan({root:projectRoot,sdk:options.sdk,deployment:options.deployment,env})
    .filter(plan=>options.browser==='all'||plan.browser===options.browser)
  const output=mkdtempSync(join(tmpdir(),'native-sdk-repeats-'))
  const receipt={scope:'Repeated complete five-example SDK and owner/terminal/agent workflows, tracing off, not a same-browser soak, full-site, production or publication check.',
    output,node:process.version,runs:options.runs,browsers:plans.map(plan=>plan.browser),identity:before,driverSHA256,
    rows:[],complete:false,passed:false}
  const save=()=>writeFileSync(join(output,'results.json'),JSON.stringify(receipt,null,2)+'\n')
  console.log('NATIVE_SDK_REPEATS_REPORT '+join(output,'results.json'));save()
  outer:for(let iteration=1;iteration<=options.runs;iteration++)for(const plan of plans){
    console.log('NATIVE_SDK_REPEAT_START '+JSON.stringify({iteration,browser:plan.browser,output}))
    const started=performance.now()
    let child
    try{child=run(plan.command,plan.args,{...plan.options,stdio:'pipe',encoding:'utf8',maxBuffer:64*1024*1024})}
    catch(error){child={status:null,error,stdout:error?.stdout,stderr:error?.stderr}}
    const log=join(output,`run-${iteration}-${plan.browser}.log`)
    writeFileSync(log,String(child.stdout??'')+String(child.stderr??''),{flag:'wx'})
    const row={iteration,browser:plan.browser,status:child.status,signal:child.signal,error:child.error?String(child.error):undefined,
      elapsedMs:Math.round(performance.now()-started),log,...nativeSDKRepeatOutcome(child,plan.browser)}
    try{
      assert.deepEqual(identity(projectRoot,options.sdk,options.deployment),before,'SDK repeat inputs changed')
      assert.equal(nativeExampleHash(readFileSync(fileURLToPath(import.meta.url))),driverSHA256,'SDK repeat driver changed')
      row.inputsUnchanged=true
    }catch(error){row.passed=false;row.inputError=String(error)}
    receipt.rows.push(row);save()
    console.log('NATIVE_SDK_REPEAT '+JSON.stringify(row))
    // Stop on the first failed original workflow. A later pass never replaces it.
    if(!row.passed){receipt.stoppedReason=row.inputError?'SDK repeat inputs changed':'Original SDK workflow failed';break outer}
  }
  receipt.complete=receipt.rows.length===options.runs*plans.length&&!receipt.stoppedReason
  receipt.passed=receipt.complete&&receipt.rows.every(row=>row.passed&&row.inputsUnchanged)
  save();return receipt
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const receipt=runNativeSDKRepeats(nativeSDKRepeatOptions(process.argv.slice(2)))
  if(!receipt.passed)process.exitCode=1
}
