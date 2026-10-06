import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {checkNativeSDK,nativeSDKCheckEnvironment,runNativeSDKCheckCommand,readNativeSDKCheckAcceptance,readNativeSDKCheckDirectories,readNativeSDKCheckCommandLifecycles} from '../scripts/check-native-sdk.mjs'

const rows=()=>['chromium','firefox','webkit'].map(browser=>({browser,passed:true,examples:5,version:'0.0.0',
  examplesRevision:'f'.repeat(40),runners:{'tests/native-owner-sdk.test.mjs':'a'.repeat(64)},
  sdkManifestSHA256:'a'.repeat(64),runtimeManifestSHA256:'b'.repeat(64),deploymentManifestSHA256:'c'.repeat(64),examplesManifestSHA256:'d'.repeat(64)}))
const output=entries=>entries.map(row=>'NATIVE_RELEASE_ACCEPTANCE '+JSON.stringify(row)).join('\n')

test('captured native checks retain ordinary success output and return the original result',()=>{
  const args=['original-script.mjs'],options={stdio:'pipe',encoding:'utf8',maxBuffer:64*1024*1024}
  const stdout=[],stderr=[]
  const result=runNativeSDKCheckCommand((command,actualArgs,actualOptions)=>{
    assert.equal(command,process.execPath);assert.equal(actualArgs,args);assert.equal(actualOptions,options)
    return 'original success output\n'
  },args,options,{stdout:bytes=>stdout.push(bytes),stderr:bytes=>stderr.push(bytes)})
  assert.equal(result,'original success output\n')
  assert.deepEqual(stdout,[result]);assert.deepEqual(stderr,[])
})
test('captured native failures keep both output streams and the original error',()=>{
  for(const binary of [false,true]){
    const stdout=[],stderr=[]
    const error=Object.assign(Error('original failure'),{status:1,signal:null,
      stdout:binary?Buffer.from('completed checks\n'):'completed checks\n',
      stderr:binary?Buffer.from('original diagnostic\n'):'original diagnostic\n'})
    assert.throws(()=>runNativeSDKCheckCommand(()=>{throw error},[],{stdio:'pipe'},
      {stdout:bytes=>stdout.push(bytes),stderr:bytes=>stderr.push(bytes)}),actual=>actual===error)
    assert.deepEqual(stdout,[error.stdout]);assert.deepEqual(stderr,[error.stderr])
    assert.equal(error.status,1);assert.equal(error.signal,null)
  }
})
test('native failure output cannot replace the failure when a log sink throws or output is absent',()=>{
  for(const fields of [{stdout:'output',stderr:'error'},{stdout:null,stderr:undefined}]){
    const error=Object.assign(Error('original failure'),fields)
    assert.throws(()=>runNativeSDKCheckCommand(()=>{throw error},[],{stdio:'pipe'},
      {stdout:()=>{throw Error('stdout sink failed')},stderr:()=>{throw Error('stderr sink failed')}}),actual=>actual===error)
  }
})
test('inherited native failure output is not replayed',()=>{
  const error=Object.assign(Error('original failure'),{stdout:'output',stderr:'error'})
  const writes=[]
  assert.throws(()=>runNativeSDKCheckCommand(()=>{throw error},[],{stdio:'inherit'},
    {stdout:bytes=>writes.push(bytes),stderr:bytes=>writes.push(bytes)}),actual=>actual===error)
  assert.deepEqual(writes,[])
})

test('native CI clears publication and experimental settings but keeps ordinary environment',()=>{
  assert.deepEqual(nativeSDKCheckEnvironment({PATH:'/bin',SDK_RELEASE:'1',SDK_RELEASE_VERSION:'0.1.0-alpha.0',
    SDK_SOURCE_ARCHIVE:'/old',NATIVE_OWNER_EXAMPLE:'counter',BROWSER_VITE_ENTRY_POINT:'/old',MVDAN_TOOLCHAIN:'/old',TANSTACK_ROUTER_SOURCE:'/old'}),
    {PATH:'/bin',SDK_RELEASE:'0',SDK_BUILD_PROFILE:'native'})
})
test('native CI requires all five examples in all three engines with unchanged identity',()=>{
  assert.equal(readNativeSDKCheckAcceptance(output(rows())).length,3)
  for(const change of [entries=>entries.pop(),entries=>entries.reverse(),entries=>entries[1].passed=false,
    entries=>entries[1].examples=1,entries=>entries[1].sdkManifestSHA256='e'.repeat(64),entries=>entries[0].version='0.1.0-alpha.0',
    entries=>delete entries[0].runners,entries=>delete entries[0].examplesRevision]){
    const entries=rows();change(entries)
    assert.throws(()=>readNativeSDKCheckAcceptance(output(entries)))
  }
})
test('native CI requires directory workload, exports and context in every browser/toolchain pair',()=>{
  const toolchains=[{vite:'8.3.1',rolldown:'1.2.11'},{vite:'8.3.2',rolldown:'1.2.12'}]
  const inputs={kind:'installed-directory-control-inputs',testSHA256:'a'.repeat(64),workloadSHA256:'b'.repeat(64),runnerLockSHA256:'c'.repeat(64)}
  const makeRows=()=>['chromium','firefox','webkit'].flatMap(browser=>toolchains.map(toolchain=>({
    browser,toolchain,passed:true,callbackContext:true,namedExports:true,commands:0,errors:[],
    checks:Array.from({length:26},(_,index)=>'check '+index),
  })))
  const serialize=entries=>[inputs,...entries].map(row=>JSON.stringify(row)).join('\n')
  assert.equal(readNativeSDKCheckDirectories(serialize(makeRows()),toolchains).rows.length,6)
  for(const change of [entries=>entries.pop(),entries=>entries[0].checks.pop(),entries=>entries[1]=entries[0],
    entries=>entries[0].checks[1]=entries[0].checks[0],entries=>entries[0].passed=false,
    entries=>entries[0].callbackContext=false,entries=>entries[0].namedExports=false,
    entries=>entries[0].commands=1,entries=>entries[0].errors.push('page error')]){
    const entries=makeRows();change(entries)
    assert.throws(()=>readNativeSDKCheckDirectories(serialize(entries),toolchains))
  }
  assert.throws(()=>readNativeSDKCheckDirectories(makeRows().map(row=>JSON.stringify(row)).join('\n'),toolchains))
})
test('native CI refuses existing runtime outputs without running a build',()=>{
  const root=mkdtempSync(join(tmpdir(),'native-ci-output-test-'))
  mkdirSync(join(root,'public/mvdan-shell'),{recursive:true})
  assert.throws(()=>checkNativeSDK({root,run:()=>{throw Error('must not run')}}),/fresh checkout/)
})
test('native CI requires ordinary command finish and cancellation replacements in every pair',()=>{
  const toolchains=[{vite:'8.3.1',rolldown:'1.2.11'},{vite:'8.3.2',rolldown:'1.2.12'}]
  const inputs={kind:'command-lifecycle-inputs',testSHA256:'a'.repeat(64),runnerLockSHA256:'b'.repeat(64),selected:['chromium','firefox','webkit']}
  const makeRows=()=>inputs.selected.flatMap(browser=>toolchains.map(toolchain=>({
    kind:'command-lifecycle-result',browser,toolchain,passed:true,errors:[],
    commands:['natural','cancel','natural','cancel'].map(previous=>({previous,replacementStatus:0,commands:0,previousMs:20,replacementMs:20})),
  })))
  const serialize=(entries,input=inputs)=>[input,...entries].map(row=>JSON.stringify(row)).join('\n')
  assert.equal(readNativeSDKCheckCommandLifecycles(serialize(makeRows()),toolchains).rows.length,6)
  for(const change of [entries=>entries.pop(),entries=>entries[1]=entries[0],entries=>entries[0].passed=false,
    entries=>entries[0].errors.push('page error'),entries=>entries[0].commands.pop(),
    entries=>entries[0].commands[1].previous='natural',entries=>entries[0].commands[0].replacementStatus=1,
    entries=>entries[0].commands[0].commands=1,entries=>entries[0].commands[0].previousMs=-1,
    entries=>delete entries[0].commands[0].replacementMs]){
    const entries=makeRows();change(entries)
    assert.throws(()=>readNativeSDKCheckCommandLifecycles(serialize(entries),toolchains))
  }
  assert.throws(()=>readNativeSDKCheckCommandLifecycles(serialize(makeRows(),{...inputs,selected:['webkit']}),toolchains))
  assert.throws(()=>readNativeSDKCheckCommandLifecycles(makeRows().map(row=>JSON.stringify(row)).join('\n'),toolchains))
  assert.throws(()=>readNativeSDKCheckCommandLifecycles(serialize(makeRows(),{...inputs,testSHA256:undefined}),toolchains))
  const source=readFileSync('scripts/check-native-sdk.mjs','utf8')
  assert.match(source,/report\.commandLifecycles=readNativeSDKCheckCommandLifecycles\(execute\('tests\/native-command-lifecycle-sdk\.test\.mjs'/)
  assert.match(source,/assert\.deepEqual\(report\.commandLifecycles\.inputs\.identity,acceptanceIdentity/)
  assert.match(source,/assert\.equal\(report\.commandLifecycles\.inputs\.runnerLockSHA256,report\.directories\.inputs\.runnerLockSHA256/)
})
test('native CI retains a failed build phase and cannot continue into packaging',()=>{
  const root=mkdtempSync(join(tmpdir(),'native-ci-failure-test-'))
  writeFileSync(join(root,'package.json'),'{}')
  let calls=0
  assert.throws(()=>checkNativeSDK({root,run:()=>{calls++;throw Error('expected build failure')}}),/expected build failure/)
  assert.equal(calls,1)
  const report=JSON.parse(readFileSync(join(root,'test-results/native-sdk-check.json')))
  assert.equal(report.passed,false);assert.equal(report.phase,'runtime build')
  assert.deepEqual(report.error,{name:'Error'})
})
test('native CI requires installed bootstrap cases on the identical package and browser runner',()=>{
  const source=readFileSync('scripts/check-native-sdk.mjs','utf8')
  assert.match(source,/report\.commandBootstrap=readNativeCommandBootstrapResults\(execute\('tests\/native-command-bootstrap-sdk\.test\.mjs'/)
  assert.match(source,/NATIVE_COMMAND_BOOTSTRAP_CONTROL:'1'/)
  assert.match(source,/assert\.deepEqual\(report\.commandBootstrap\.inputs\.identity,acceptanceIdentity/)
  assert.match(source,/assert\.equal\(report\.commandBootstrap\.inputs\.runnerLockSHA256,report\.directories\.inputs\.runnerLockSHA256/)
})
test('private native CI cannot publish, change release gates or upload compiler artifacts',()=>{
  const workflow=readFileSync('.github/workflows/native-checks.yml','utf8')
  assert.match(workflow,/node-version-file: .nvmrc/)
  assert.match(workflow,/npm ci --prefix tests\/fixtures\/native-runtime-832 --ignore-scripts/)
  assert.match(workflow,/playwright install --with-deps chromium firefox webkit/)
  assert.match(workflow,/node scripts\/setup-release-toolchains.mjs/)
  assert.match(workflow,/node scripts\/check-native-sdk.mjs/)
  assert.match(workflow,/if: always\(\)/)
  assert.match(workflow,/path: test-results\/native-sdk-check.json/)
  assert.doesNotMatch(workflow,/pull_request_target|id-token: write|contents: write|secrets\.|npm publish|changeset|release:prepare|NPM_TOKEN|NODE_AUTH_TOKEN/)
})
test('native CI includes the complete same-owner soak on the identical installed package and browser inputs',()=>{
  const source=readFileSync('scripts/check-native-sdk.mjs','utf8')
  assert.match(source,/report\.ownerSoak=readNativeOwnerSoakResults\(execute\('tests\/native-owner-soak-sdk\.test\.mjs'/)
  assert.match(source,/NATIVE_OWNER_SOAK:'1'/)
  assert.match(source,/assert\.deepEqual\(report\.ownerSoak\.inputs\.identity,acceptanceIdentity/)
  assert.match(source,/assert\.equal\(report\.ownerSoak\.inputs\.runnerLockSHA256,report\.directories\.inputs\.runnerLockSHA256/)
})
