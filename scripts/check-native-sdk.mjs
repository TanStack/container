import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createSourceSnapshot,verifySourceSnapshot} from './source-snapshot.mjs'
import {nativeRuntimeBuildPlan} from './native-runtime-build-plan.mjs'
import {readNativeOwnerSoakResults} from './native-owner-soak-accounting.mjs'
import {nativeReleaseExamples} from './native-example-sources.mjs'
import {nativeOwnerTimingRecord} from './native-owner-timings.mjs'
import {readNativeCommandBootstrapResults} from './native-command-bootstrap-results.mjs'
export {readNativeCommandBootstrapResults} from './native-command-bootstrap-results.mjs'

const sourceRoot=fileURLToPath(new URL('..',import.meta.url))
export function nativeSDKCheckEnvironment(env=process.env){
  return {...Object.fromEntries(Object.entries(env).filter(([name])=>
    !/^(?:SDK_|NATIVE_|BROWSER_|MVDAN_)/.test(name)&&name!=='TANSTACK_ROUTER_SOURCE')),SDK_RELEASE:'0',SDK_BUILD_PROFILE:'native'}
}

export function runNativeSDKCheckCommand(run,args,options,{
  stdout=bytes=>process.stdout.write(bytes),stderr=bytes=>process.stderr.write(bytes),
}={}){
  try{
    const output=run(process.execPath,args,options)
    if(options.stdio==='pipe')stdout(String(output))
    return output
  }catch(error){
    if(options.stdio==='pipe'){
      for(const [write,bytes]of [[stdout,error.stdout],[stderr,error.stderr]]){
        if(typeof bytes!=='string'&&!Buffer.isBuffer(bytes))continue
        // A failed log sink must not replace the original command failure.
        try{write(bytes)}catch{}
      }
    }
    throw error
  }
}

export function readNativeSDKCheckAcceptance(output){
  const rows=String(output).split('\n').filter(line=>line.startsWith('NATIVE_RELEASE_ACCEPTANCE '))
    .map(line=>JSON.parse(line.slice('NATIVE_RELEASE_ACCEPTANCE '.length)))
  assert.deepEqual(rows.map(row=>row.browser),['chromium','firefox','webkit'],'Native CI must complete all three engines')
  for(const row of rows){
    assert.equal(row.passed,true)
    assert.equal(row.examples,5,'Native CI must use the full pinned example suite')
    assert.equal(row.version,'0.0.0','Native CI packages must stay private development builds')
    assert.match(row.examplesRevision,/^[a-f0-9]{40}$/)
    assert.ok(row.runners&&Object.keys(row.runners).length,'Native CI must retain test runner identities')
    for(const value of Object.values(row.runners))assert.match(value,/^[a-f0-9]{64}$/)
    for(const field of ['sdkManifestSHA256','runtimeManifestSHA256','deploymentManifestSHA256','examplesManifestSHA256'])
      assert.match(row[field],/^[a-f0-9]{64}$/)
    const {browser,passed,...identity}=row
    const {browser:firstBrowser,passed:firstPassed,...first}=rows[0]
    assert.deepEqual(identity,first,'Native CI inputs changed between engines')
  }
  return rows
}

export function readNativeSDKCheckTimings(output,{complete=true}={}){
  const rows=String(output).split('\n').filter(line=>line.startsWith('{'))
    .map(line=>JSON.parse(line)).filter(row=>row&&Object.hasOwn(row,'timings'))
  const expected=['chromium','firefox','webkit'].flatMap(browser=>
    nativeReleaseExamples.map(({kind,path})=>({browser,example:kind+'/'+path})))
  assert.ok(rows.length<=expected.length,'Too many SDK timing records')
  if(complete)assert.equal(rows.length,expected.length,'SDK timings must cover all 15 original example checks')
  assert.deepEqual(rows.map(({browser,example})=>({browser,example})),expected.slice(0,rows.length),
    'SDK timings must retain the original browser and example order')
  for(const row of rows){
    assert.deepEqual(row,nativeOwnerTimingRecord({browser:row.browser,example:row.example,result:row}),
      'Unexpected SDK timing fields')
    assert.ok(row.startupStages.length,'SDK timing record is missing startup phases')
    let previous=0
    for(const {elapsedMs}of row.startupStages){
      if(elapsedMs===undefined)continue
      assert.ok(elapsedMs>=previous,'SDK startup phase clock went backwards')
      previous=elapsedMs
    }
  }
  return rows
}

export function captureNativeSDKCheckTimings(run,report){
  let output
  try{output=run()}
  catch(error){
    report.timingsComplete=false
    // Reporting must never replace the original browser command failure.
    try{report.timings=readNativeSDKCheckTimings(error.stdout??'',{complete:false})}
    catch(captureError){report.timingCaptureError=String(captureError)}
    throw error
  }
  report.timings=readNativeSDKCheckTimings(output)
  report.timingsComplete=true
  return output
}

export function readNativeSDKCheckDirectories(output,toolchains){
  assert.ok(Array.isArray(toolchains)&&toolchains.length===2,'Directory CI requires both shipped toolchains')
  const records=String(output).split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line))
  const inputs=records.filter(row=>row.kind==='installed-directory-control-inputs')
  assert.equal(inputs.length,1,'Directory CI must retain exactly one input identity')
  for(const field of ['testSHA256','workloadSHA256','runnerLockSHA256'])assert.match(inputs[0][field],/^[a-f0-9]{64}$/)
  const rows=records.filter(row=>typeof row.browser==='string')
  assert.equal(rows.length,6,'Directory CI must complete both toolchains in all three engines')
  for(const browser of ['chromium','firefox','webkit'])for(const toolchain of toolchains){
    const matching=rows.filter(row=>row.browser===browser&&row.toolchain?.vite===toolchain.vite&&row.toolchain?.rolldown===toolchain.rolldown)
    assert.equal(matching.length,1,'Missing or duplicate directory CI pair: '+browser+'/'+toolchain.vite)
    const row=matching[0]
    for(const field of ['passed','callbackContext','namedExports'])assert.equal(row[field],true,'Incomplete directory CI check: '+field)
    assert.ok(Array.isArray(row.checks)&&row.checks.length===26&&new Set(row.checks).size===26,'Directory CI must run all 26 checks')
    assert.equal(row.commands,0,'Directory CI left a command running')
    assert.deepEqual(row.errors,[],'Directory CI reported browser errors')
  }
  return {inputs:inputs[0],rows}
}

export function readNativeSDKCheckCommandLifecycles(output,toolchains){
  assert.ok(Array.isArray(toolchains)&&toolchains.length===2,'Command CI requires both shipped toolchains')
  const records=String(output).split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line))
  const inputs=records.filter(row=>row.kind==='command-lifecycle-inputs')
  assert.equal(inputs.length,1,'Command CI must retain exactly one input identity')
  for(const field of ['testSHA256','runnerLockSHA256'])assert.match(inputs[0][field],/^[a-f0-9]{64}$/)
  assert.deepEqual(inputs[0].selected,['chromium','firefox','webkit'],'Command CI must select all three engines')
  const rows=records.filter(row=>row.kind==='command-lifecycle-result')
  assert.equal(rows.length,6,'Command CI must complete both toolchains in every engine')
  for(const browser of inputs[0].selected)for(const toolchain of toolchains){
    const matching=rows.filter(row=>row.browser===browser&&row.toolchain?.vite===toolchain.vite&&row.toolchain?.rolldown===toolchain.rolldown)
    assert.equal(matching.length,1,'Missing or duplicate command CI pair: '+browser+'/'+toolchain.vite)
    const row=matching[0]
    assert.equal(row.passed,true,'Command lifecycle failed')
    assert.deepEqual(row.errors,[],'Command lifecycle reported browser errors')
    assert.deepEqual(row.commands?.map(command=>command.previous),['natural','cancel','natural','cancel'],'Command lifecycle skipped a sequence')
    for(const command of row.commands){
      assert.equal(command.replacementStatus,0,'Replacement command failed')
      assert.equal(command.commands,0,'Command lifecycle left a command running')
      for(const field of ['previousMs','replacementMs'])assert.ok(Number.isSafeInteger(command[field])&&command[field]>=0,'Invalid command timing')
    }
  }
  return {inputs:inputs[0],rows}
}

export function checkNativeSDK({root=sourceRoot,env=process.env,run=execFileSync}={}){
  root=resolve(root)
  for(const directory of ['public/mvdan-shell','public/native-runtimes'])
    assert.equal(existsSync(join(root,directory)),false,'Native CI requires a fresh checkout: '+directory)
  const reportPath=join(root,'test-results/native-sdk-check.json')
  assert.equal(existsSync(reportPath),false,'Native CI report already exists')
  const workspace=mkdtempSync(join(tmpdir(),'native-sdk-check-'))
  const sourceArchive=join(workspace,'source.tar.gz')
  const source=createSourceSnapshot(root,sourceArchive)
  const environment={...nativeSDKCheckEnvironment(env),SDK_SOURCE_ARCHIVE:sourceArchive}
  const report={format:1,scope:'Private native source build, package adoption, five-example desktop SDK checks, installed Node directory/context, command lifecycle and same-owner soak checks, not site integration, publication or production acceptance.',
    node:process.version,source,passed:false,phase:'runtime build'}
  mkdirSync(join(root,'test-results'),{recursive:true})
  const execute=(script,args=[],capture=false,extraEnvironment={})=>{
    return runNativeSDKCheckCommand(run,[join(root,script),...args],{cwd:root,env:{...environment,...extraEnvironment},
      stdio:capture?'pipe':'inherit',encoding:'utf8',maxBuffer:64*1024*1024})
  }
  try{
    execute('scripts/build-release-runtime.mjs')
    environment.SDK_NATIVE_RUNTIME_ROOTS=JSON.stringify(nativeRuntimeBuildPlan(root).map(item=>item.output))
    report.phase='SDK build'
    const output=execute('scripts/build-sdk.mjs',[],true)
    const entries=[...String(output).matchAll(/^SDK_OUTPUT=(.+)$/gm)]
    assert.equal(entries.length,1,'Expected exactly one private SDK staging output')
    report.phase='split packaging'
    const split=JSON.parse(execute('scripts/build-sdk-packages.mjs',[entries[0][1]],true))
    for(const directory of [split.core,split.runtime]){
      const pkg=JSON.parse(readFileSync(join(directory,'package.json')))
      assert.equal(pkg.private,true,'Native CI must not produce publication-format packages')
      assert.equal(pkg.version,'0.0.0')
    }
    report.phase='consumer adoption'
    const adoption=JSON.parse(execute('scripts/test-sdk-packages.mjs',[split.output],true))
    for(const field of ['passed','nativeOnly','nativeBundleChecked','reinstall','reinstalledDeploymentMatches'])
      assert.equal(adoption[field],true,'Incomplete native adoption: '+field)
    const sdk=join(adoption.consumer,'node_modules/@tanstack/browser-sandbox-experimental')
    report.phase='desktop SDK acceptance'
    report.acceptance=readNativeSDKCheckAcceptance(captureNativeSDKCheckTimings(
      ()=>execute('scripts/native-release-acceptance.mjs',[sdk,adoption.output.directory],true),report))
    report.phase='installed Node directory acceptance'
    report.directories=readNativeSDKCheckDirectories(execute('tests/native-owner-directory-sdk.test.mjs',[],true,{
      NATIVE_OWNER_DIRECTORY_CONTROL:'1',NATIVE_DIRECTORY_PLAYWRIGHT_ROOT:root,
      NATIVE_SDK_BUNDLE_DIR:sdk,NATIVE_DEPLOYMENT_DIR:adoption.output.directory,
    }),nativeRuntimeBuildPlan(root).map(({vite,rolldown})=>({vite,rolldown})))
    const {browser,passed,...acceptanceIdentity}=report.acceptance[0]
    assert.deepEqual(report.directories.inputs.identity,acceptanceIdentity,'Directory CI package identity differs from example acceptance')
    report.phase='installed Node command lifecycle acceptance'
    report.commandLifecycles=readNativeSDKCheckCommandLifecycles(execute('tests/native-command-lifecycle-sdk.test.mjs',[],true,{
      NATIVE_COMMAND_LIFECYCLE_CONTROL:'1',NATIVE_COMMAND_PLAYWRIGHT_ROOT:root,
      NATIVE_SDK_BUNDLE_DIR:sdk,NATIVE_DEPLOYMENT_DIR:adoption.output.directory,
    }),nativeRuntimeBuildPlan(root).map(({vite,rolldown})=>({vite,rolldown})))
    assert.deepEqual(report.commandLifecycles.inputs.identity,acceptanceIdentity,'Command CI package identity differs from example acceptance')
    assert.equal(report.commandLifecycles.inputs.runnerLockSHA256,report.directories.inputs.runnerLockSHA256,'Command and directory CI use different browser runners')
    report.phase='installed Node command bootstrap acceptance'
    report.commandBootstrap=readNativeCommandBootstrapResults(execute('tests/native-command-bootstrap-sdk.test.mjs',[],true,{
      NATIVE_COMMAND_BOOTSTRAP_CONTROL:'1',NATIVE_SDK_BUNDLE_DIR:sdk,NATIVE_DEPLOYMENT_DIR:adoption.output.directory,
    }),nativeRuntimeBuildPlan(root).map(({vite,rolldown})=>({vite,rolldown})))
    assert.deepEqual(report.commandBootstrap.inputs.identity,acceptanceIdentity,'Bootstrap CI package identity differs from example acceptance')
    assert.equal(report.commandBootstrap.inputs.runnerLockSHA256,report.directories.inputs.runnerLockSHA256,'Bootstrap CI uses a different browser runner')
    report.phase='same-owner lifecycle acceptance'
    report.ownerSoak=readNativeOwnerSoakResults(execute('tests/native-owner-soak-sdk.test.mjs',[],true,{
      NATIVE_OWNER_SOAK:'1',NATIVE_COMMAND_PLAYWRIGHT_ROOT:root,
      NATIVE_SDK_BUNDLE_DIR:sdk,NATIVE_DEPLOYMENT_DIR:adoption.output.directory,
    }),nativeRuntimeBuildPlan(root).map(({vite,rolldown})=>({vite,rolldown})))
    assert.deepEqual(report.ownerSoak.inputs.identity,acceptanceIdentity,'Owner soak package identity differs from example acceptance')
    assert.equal(report.ownerSoak.inputs.runnerLockSHA256,report.directories.inputs.runnerLockSHA256,'Owner soak uses a different browser runner')
    verifySourceSnapshot(root,sourceArchive)
    report.adoption={packages:adoption.packages.map(({name,sha256,reproducible})=>({name,sha256,reproducible})),
      typeResolution:adoption.typeResolution,reinstall:adoption.reinstall,reinstalledDeploymentMatches:adoption.reinstalledDeploymentMatches}
    report.passed=true;report.phase='complete'
    return report
  }catch(error){
    report.error={name:error.name}
    throw error
  }finally{
    writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'})
    console.log('NATIVE_SDK_CHECK_REPORT '+reportPath)
  }
}

export function runNativeSDKCheckCLI(check=checkNativeSDK){
  try{return check()}
  catch(error){
    // Uncaught exceptions can exit before replayed pipe output has drained.
    // Keep the failed status, let Node finish both streams, and do not print
    // the captured output a second time inside the child-process error object.
    process.exitCode=1
    console.error(error instanceof Error?error.stack:String(error))
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.equal(process.argv.length,2,'Usage: node scripts/check-native-sdk.mjs')
  runNativeSDKCheckCLI()
}
