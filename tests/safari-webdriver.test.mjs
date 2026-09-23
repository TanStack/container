import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {classifySafariDriverFailure,createSafariEvidence,inspectSafariAutomationProcess,parseSafariAutomationProcesses,parseWebDriverResponse,SafariWebDriver,verifySafariFiberResult} from '../scripts/safari-webdriver.mjs'
import {advanceSafariDocumentStability,classifySafariCapacityFailure,installSafariAcceptanceConsumer,readSafariArtifactIdentity} from '../scripts/safari-framework-acceptance.mjs'
import {safariCapacityBridge,safariCapacityInstrumentation} from '../scripts/safari-framework-proxy.mjs'

test('WebDriver protocol accepts values and preserves remote errors',()=>{
  assert.deepEqual(parseWebDriverResponse(200,JSON.stringify({value:{ready:true}}),'status'),{ready:true})
  assert.throws(()=>parseWebDriverResponse(500,JSON.stringify({value:{error:'session not created',message:'bad capability'}}),'session'),error=>error.code==='session not created'&&/bad capability/.test(error.message))
  const disabled=classifySafariDriverFailure('Session not created because Allow Remote Automation is disabled')
  assert.equal(disabled.code,'ERR_SAFARI_REMOTE_AUTOMATION_DISABLED');assert.match(disabled.message,/Enable Develop/)
})

test('session bounds browser navigation before the client request deadline',async()=>{
  const driver=new SafariWebDriver('http://127.0.0.1:1'),calls=[]
  driver.request=async(...args)=>{calls.push(args);return calls.length===1?{sessionId:'probe',capabilities:{browserName:'safari'}}:null}
  assert.deepEqual(await driver.createSession(),{browserName:'safari'})
  assert.deepEqual(calls[1],['POST','/session/probe/timeouts',{pageLoad:55_000},undefined])
  await driver.navigate('http://127.0.0.1:1234/')
  assert.equal(calls[2][3],60_000)
})

test('session does not hide a browser timeout configuration failure',async()=>{
  const driver=new SafariWebDriver('http://127.0.0.1:1')
  driver.request=async(method,path)=>{if(path==='/session')return {sessionId:'probe',capabilities:{browserName:'safari'}};throw Error('timeout configuration rejected')}
  await assert.rejects(driver.createSession(),/timeout configuration rejected/)
  assert.equal(driver.sessionId,'probe')
})

test('fiber probe rejects timeouts, failures, partial completion and incorrect arithmetic',()=>{
  const passed={status:'passed',completed:20,last:{value:239998879}}
  assert.doesNotThrow(()=>verifySafariFiberResult(passed,20))
  for(const result of [undefined,{...passed,status:'timeout'},{...passed,status:'failed'},{...passed,completed:19},{...passed,last:{value:42}}]){
    assert.throws(()=>verifySafariFiberResult(result,20),/did not complete correctly/)
  }
  assert.throws(()=>verifySafariFiberResult(passed,0),/Invalid expected/)
  const source=readFileSync(resolve('scripts/safari-fiber-workload-memory.mjs'),'utf8')
  assert.match(source,/if \(state.last.value !== 239998879\) throw Error/)
  assert.match(source,/verifySafariFiberResult\(report.result,cycles\)/)
})

test('trusted pointer clicks use the frame-aware WebDriver element command',async()=>{
  const driver=new SafariWebDriver('http://127.0.0.1:1'),calls=[]
  driver.command=async(...args)=>{calls.push(args);return null}
  await driver.pointerClick({'element-6066-11e4-a52e-4f735466cecf':'frame-button'})
  assert.deepEqual(calls,[['POST','/element/frame-button/click',{}]])
})

test('window ownership inspection uses WebDriver window commands',async()=>{
  const driver=new SafariWebDriver('http://127.0.0.1:1'),calls=[]
  driver.sessionId='owned-session'
  driver.command=async(...args)=>{calls.push(args);return args[1].endsWith('handles')?['window-one']:'window-one'}
  assert.equal(await driver.windowHandle(),'window-one')
  assert.deepEqual(await driver.windowHandles(),['window-one'])
  assert.deepEqual(calls,[['GET','/window'],['GET','/window/handles']])
})

test('artifact identity binds the manifest, profile and tarball bytes',()=>{
  const root=mkdtempSync(join(tmpdir(),'safari-artifact-')),example=join(root,'examples/frameworks'),tarball=join(root,'candidate.tgz')
  mkdirSync(example,{recursive:true});writeFileSync(join(example,'server.mjs'),'export {}');writeFileSync(join(root,'manifest.json'),JSON.stringify({buildProfile:'sync-o2'}));writeFileSync(tarball,'archive')
  const identity=readSafariArtifactIdentity({sdkRoot:root,tarball})
  assert.equal(identity.buildProfile,'sync-o2');assert.match(identity.manifestSHA256,/^[a-f0-9]{64}$/);assert.match(identity.tarballSHA256,/^[a-f0-9]{64}$/)
  assert.deepEqual(readSafariArtifactIdentity({sdkRoot:root,tarball,expected:{manifestSHA256:identity.manifestSHA256,buildProfile:'sync-o2',tarballSHA256:identity.tarballSHA256}}),identity)
  assert.throws(()=>readSafariArtifactIdentity({sdkRoot:root,tarball,expected:{tarballSHA256:'0'.repeat(64)}}),/tarballSHA256 mismatch/)
})

test('Safari acceptance installs and loads the exact packed SDK as an external consumer',t=>{
  const sdkRoot=process.env.SDK_OUTPUT,tarball=process.env.SDK_TARBALL
  if(!sdkRoot||!tarball){t.skip('Set SDK_OUTPUT and SDK_TARBALL to exercise the packaged Safari consumer');return}
  const artifact=readSafariArtifactIdentity({sdkRoot,tarball})
  const installed=installSafariAcceptanceConsumer(artifact)
  assert.notEqual(installed.sdkRoot,artifact.sdkRoot)
  assert.match(installed.sdkRoot,/node_modules\/@tanstack\/browser-sandbox-experimental$/)
  assert.equal(readFileSync(join(installed.sdkRoot,'manifest.json')).equals(readFileSync(join(artifact.sdkRoot,'manifest.json'))),true)
})

test('Safari evidence keeps cold and resume outcomes distinct',()=>{
  const results={vite:{cold:{status:'passed',evidence:['cold']},resume:{status:'passed',evidence:['resume']}},start:{cold:{status:'passed',evidence:['cold']},resume:{status:'passed',evidence:['resume']}}}
  const rounds=[1,2,3].map(index=>({index,results:structuredClone(results)}))
  const evidence=createSafariEvidence({identity:{manifestSHA256:'a'.repeat(64),buildProfile:'sync-o2',tarballSHA256:'b'.repeat(64)},capabilities:{browserName:'Safari',browserVersion:'26.6.2'},startedAt:'start',finishedAt:'finish',results,rounds})
  assert.equal(evidence.actualSafari,true);assert.equal(evidence.browser.version,'26.6.2');assert.equal(evidence.passed,true);assert.match(evidence.method,/safaridriver/)
  assert.equal(createSafariEvidence({identity:{},capabilities:{browserName:'safari',browserVersion:'26.6.2'},results,rounds:rounds.slice(0,2)}).passed,false)
  results.start.resume={status:'failed',evidence:['failure']};assert.equal(createSafariEvidence({identity:{},capabilities:{browserName:'safari'},results,rounds}).passed,false)
  assert.throws(()=>createSafariEvidence({identity:{},capabilities:{browserName:'webkit'},results}),/Expected Safari/)
  assert.equal(createSafariEvidence({identity:{},results:{vite:{cold:{status:'unverified'},resume:{status:'unverified'}},start:{cold:{status:'unverified'},resume:{status:'unverified'}}}}).actualSafari,false)
})

test('the harness never enables Safari automation or mutates preferences',()=>{
  const source=readFileSync(resolve('scripts/safari-framework-acceptance.mjs'),'utf8')+readFileSync(resolve('scripts/safari-webdriver.mjs'),'utf8')
  assert.doesNotMatch(source,/safaridriver[^\n]*--enable/)
  assert.doesNotMatch(source,/\bdefaults\s+(?:write|delete)\b/)
})

test('capacity instrumentation observes owner creation and acknowledged shutdown without changing runtime assets',()=>{
  assert.match(safariCapacityInstrumentation,/new Proxy\(NativeWorker/)
  assert.match(safariCapacityInstrumentation,/worker\.shutdown-request/)
  assert.match(safariCapacityInstrumentation,/shutdown-acknowledged/)
  assert.match(safariCapacityBridge,/session\.kernel\.resources\(\)/)
  assert.match(safariCapacityBridge,/current\.close\(\)[\s\S]*Promise\.resolve\(current\.kernel\.shutdown\)\.then/)
  assert.doesNotMatch(safariCapacityInstrumentation+safariCapacityBridge,/\/runtime\//)
})

test('Safari hydration stability uses document identity instead of its drifting time origin',()=>{
  let state={documentId:undefined,stableSince:0,ready:false}
  state=advanceSafariDocumentStability(state,{documentId:'one',timeOrigin:100.02,ready:true},1_000)
  assert.equal(state.ready,false)
  state=advanceSafariDocumentStability(state,{documentId:'one',timeOrigin:100.04,ready:true},6_001)
  assert.equal(state.ready,true)
  state=advanceSafariDocumentStability(state,{documentId:'two',timeOrigin:100.06,ready:true},7_000)
  assert.deepEqual(state,{documentId:'two',stableSince:7_000,ready:false})
  assert.deepEqual(advanceSafariDocumentStability(state,{documentId:'two',timeOrigin:100.08,ready:false},8_000),{documentId:undefined,stableSince:0,ready:false})
})

test('Safari capacity sampling skips active owner work and never overlaps resource requests',async()=>{
  let sampler,disabled=true,resourceCalls=0,fetchCalls=0,release,payload
  const interrupt={phase:'interrupt',reason:'deadline',budget:{timeoutMs:30000,remainingMs:-1}}
  const jobProfile=[{phase:'job',jobs:100},interrupt]
  const resources=()=>{resourceCalls++;return new Promise(resolve=>{release=resolve})}
  const context={
    testSession:{kernel:{resources,jobProfile}},document:{querySelector:()=>({disabled}),querySelectorAll:()=>[],visibilityState:'visible',readyState:'complete'},performance:{now:()=>1},
    globalThis:{__safariWorkerCapacity:{snapshot:()=>({created:0,active:0,released:0,workers:[]})}},
    setInterval:callback=>{sampler=callback;return 1},clearInterval(){},addEventListener(){},
    fetch:async(_url,options)=>{fetchCalls++;payload=JSON.parse(options.body)},console,
  }
  Function(...Object.keys(context),`let session=testSession;${safariCapacityBridge}`)(...Object.values(context))
  await sampler();assert.equal(resourceCalls,0)
  disabled=false
  const first=sampler();await sampler();assert.equal(resourceCalls,1)
  release({processes:{active:0}});await first
  assert.equal(fetchCalls,1)
  assert.deepEqual(payload.interrupts,[interrupt])
  assert.equal(jobProfile.length,2)
  const second=sampler();assert.equal(resourceCalls,2);release({processes:{active:0}});await second
})

test('Safari automation process discovery excludes normal Safari and unrelated commands',()=>{
  const output=`
  10 /System/Applications/Safari.app/Contents/MacOS/Safari
  11 /System/Applications/Safari.app/Contents/MacOS/Safari -ApplePersistenceIgnoreStateQuietly YES --automation
  12 /bin/zsh -c echo --automation Safari.app/Contents/MacOS/Safari
  `
  assert.deepEqual(parseSafariAutomationProcesses(output),[{
    pid:11,
    command:'/System/Applications/Safari.app/Contents/MacOS/Safari -ApplePersistenceIgnoreStateQuietly YES --automation',
  }])
})

test('owned Safari inspection rejects invalid process ids before process access',()=>{
  assert.throws(()=>inspectSafariAutomationProcess(0),/positive Safari automation process id/)
  assert.throws(()=>inspectSafariAutomationProcess(Number.NaN),/positive Safari automation process id/)
})

test('the fiber probe fails closed on existing automation and cleans up only its owned Safari pid',()=>{
  const source=readFileSync(resolve('scripts/safari-fiber-workload-memory.mjs'),'utf8')
  assert.match(source,/assertSafariAutomationAvailable\(\)/)
  assert.match(source,/stopSafariAutomationProcess\(report\.safariPID\)/)
  assert.doesNotMatch(source,/stopSafariAutomation\(\)/)
  assert.match(source,/report\.failure = errorEvidence\(error\)/)
  assert.match(source,/report\.preCleanup = await capturePreCleanupEvidence/)
  const initialization=source.indexOf("await driver.navigate('data:text/html,")
  assert.ok(initialization>0)
  assert.ok(initialization<source.indexOf('windowHandle: await driver.windowHandle()'))
})

test('all Safari harnesses fail closed and only clean up their owned automation process',()=>{
  const paths=[
    'scripts/safari-framework-acceptance.mjs',
    'scripts/safari-fiber-workload-memory.mjs',
    'scripts/safari-rolldown-workload-memory.mjs',
    'scripts/safari-esbuild-workload-memory.mjs',
    'scripts/safari-wasm-compile-memory.mjs',
    'scripts/run-tanstack-four-safari.mjs',
  ]
  for(const path of paths){
    const source=readFileSync(resolve(path),'utf8')
    assert.match(source,/assertSafariAutomationAvailable\(\)/,path)
    assert.match(source,/stopSafariAutomationProcess\(/,path)
    assert.doesNotMatch(source,/\bstopSafariAutomation\(/,path)
  }
  const webdriver=readFileSync(resolve('scripts/safari-webdriver.mjs'),'utf8')
  assert.doesNotMatch(webdriver,/export async function stopSafariAutomation\(/)
})

test('Safari WebContent memory scans use executable names without process arguments',()=>{
  const paths=[
    'scripts/safari-framework-acceptance.mjs',
    'scripts/safari-fiber-workload-memory.mjs',
    'scripts/safari-rolldown-workload-memory.mjs',
    'scripts/safari-esbuild-workload-memory.mjs',
    'scripts/safari-wasm-compile-memory.mjs',
  ]
  for(const path of paths){
    const source=readFileSync(resolve(path),'utf8')
    assert.match(source,/comm=/,path)
    assert.doesNotMatch(source,/['"]pid=,rss=,command=['"]/,path)
  }
})

test('capacity failure classification separates a lost session from an unavailable Safari process',()=>{
  assert.equal(classifySafariCapacityFailure('invalid session id',{status:'passed'}),'webdriver-session-lost')
  assert.equal(classifySafariCapacityFailure('invalid session id',{status:'failed'}),'safari-process-or-automation-unavailable')
  assert.equal(classifySafariCapacityFailure('ERR_SAFARI_ACCEPTANCE_TIMEOUT',{status:'passed'}),'workflow-failure')
})
