import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {EventEmitter} from 'node:events'
import {parseDesktopAcceptanceArgs,inspectDesktopAcceptanceSDK,assertPlainDesktopEnvironment,runDesktopAcceptance,runCommand} from '../scripts/run-sdk-desktop-acceptance.mjs'

function fixture(t,manifest={buildProfile:'plain-native-utf8-buffer',engines:{}}){
  const directory=mkdtempSync(join(tmpdir(),'sdk-desktop-acceptance-test-'))
  t.after(()=>rmSync(directory,{recursive:true}))
  const sdk=join(directory,'sdk'),output=join(directory,'results')
  mkdirSync(join(sdk,'examples/frameworks'),{recursive:true})
  writeFileSync(join(sdk,'examples/frameworks/server.mjs'),'// fixture only\n')
  writeFileSync(join(sdk,'manifest.json'),JSON.stringify(manifest))
  return {sdk,output,manifestSHA256:createHash('sha256').update(readFileSync(join(sdk,'manifest.json'))).digest('hex')}
}

test('parses explicit directories and preserves selected browser order',()=>{
  assert.deepEqual(parseDesktopAcceptanceArgs(['--sdk','artifact','--output=results','--browsers=firefox,chromium']),{sdk:'artifact',output:'results',browsers:['firefox','chromium'],manifestSHA256:undefined})
  assert.deepEqual(parseDesktopAcceptanceArgs(['--sdk=a','--output=b']).browsers,['chromium','firefox'])
  for(const args of [[],['--sdk=a'],['--sdk=a','--output=b','--timeout=900000'],['--sdk=a','--sdk=b','--output=c']])assert.throws(()=>parseDesktopAcceptanceArgs(args),/Usage/)
})

test('runs exact packaged tests serially with fixed repeats and retains command identity',async t=>{
  const f=fixture(t),calls=[],messages=[]
  let active=0
  const report=await runDesktopAcceptance({...f,browsers:['firefox','chromium']},{env:{PATH:process.env.PATH},notify:message=>messages.push(message),execute:async(command,args,options)=>{
    assert.equal(active++,0)
    calls.push({command,args,options})
    const during=JSON.parse(readFileSync(join(f.output,'report.json')))
    assert.equal(during.runs.at(-1).status,'running')
    assert.equal(during.runs.at(-1).manifestSHA256,f.manifestSHA256)
    await Promise.resolve();active--
    return {code:0,signal:null}
  }})
  assert.equal(report.status,'passed');assert.equal(calls.length,2)
  assert.equal(report.scope,'command execution only; paired workflow reports still require validation; not Safari')
  assert.deepEqual(calls.map(call=>call.args.find(arg=>arg.startsWith('--project='))),['--project=firefox','--project=chromium'])
  for(const call of calls){
    assert.equal(call.command,process.execPath)
    assert.ok(call.args[0].endsWith('/node_modules/@playwright/test/cli.js'))
    for(const arg of ['tests/sdk/framework-example.spec.mjs','--config=playwright.sdk.config.ts','--repeat-each=3','--workers=1','--retries=0'])assert.ok(call.args.includes(arg))
    assert.equal(call.args.some(arg=>arg.includes('timeout')),false)
    assert.equal(call.options.env.SDK_OUTPUT,f.sdk)
    assert.equal(call.options.env.PATH,process.env.PATH)
  }
  assert.equal(messages.length,4);assert.equal(report.manifestSHA256,f.manifestSHA256)
  assert.ok(report.runs.every(run=>run.status==='passed'&&run.exitCode===0&&run.startedAt&&run.completedAt))
})

test('stops after first failed browser and keeps the failure report',async t=>{
  const f=fixture(t);let calls=0
  const report=await runDesktopAcceptance(f,{env:{},notify(){},execute:async()=>{calls++;return {code:1}}})
  assert.equal(calls,1);assert.equal(report.status,'failed');assert.equal(report.runs[0].exitCode,1)
  assert.equal(JSON.parse(readFileSync(join(f.output,'report.json'))).status,'failed')
})

test('records process launch failure without starting a later browser',async t=>{
  const f=fixture(t);let calls=0
  const report=await runDesktopAcceptance(f,{env:{},notify(){},execute:async()=>{calls++;throw Error('launch failed')}})
  assert.equal(calls,1);assert.equal(report.status,'failed');assert.equal(report.runs[0].exitCode,null)
  assert.match(report.runs[0].error,/launch failed/)
})

test('rejects reused output and WebKit before running any browser',async t=>{
  const f=fixture(t),execute=()=>assert.fail('must not launch')
  mkdirSync(f.output);writeFileSync(join(f.output,'keep.txt'),'existing')
  await assert.rejects(runDesktopAcceptance(f,{env:{},execute}),/EEXIST/)
  assert.equal(readFileSync(join(f.output,'keep.txt'),'utf8'),'existing')
  for(const browsers of [['webkit'],['safari'],[],['firefox','firefox']])await assert.rejects(runDesktopAcceptance({...f,browsers},{env:{},execute}),/WebKit is not Safari/)
})

test('pins the manifest hash and stops when the artifact changes',async t=>{
  const f=fixture(t)
  assert.equal(inspectDesktopAcceptanceSDK(f.sdk,f.manifestSHA256).manifestSHA256,f.manifestSHA256)
  assert.throws(()=>inspectDesktopAcceptanceSDK(f.sdk,'0'.repeat(64)),/SHA256/)
  let calls=0
  const report=await runDesktopAcceptance(f,{env:{},notify(){},execute:async()=>{
    calls++;writeFileSync(join(f.sdk,'manifest.json'),JSON.stringify({buildProfile:'changed'}));return {code:0}
  }})
  assert.equal(calls,1);assert.equal(report.status,'failed');assert.match(report.error,/SHA256/)
})

test('rejects diagnostic profiles and engine metadata before creating output',async t=>{
  for(const manifest of [
    {buildProfile:'native-utf8-guest-sampling'},
    {buildProfile:'experimental-fibers-fairness'},
    {buildProfile:'plain',engines:{fiber:{metadata:{guestSampling:{}}}}},
    {buildProfile:'plain',engines:{fiber:{metadata:{fibers:{fairness:{}}}}}},
    {buildProfile:'plain',engines:{fiber:{metadata:{sortDiagnostics:{}}}}},
  ]){
    const f=fixture(t,manifest)
    await assert.rejects(runDesktopAcceptance(f,{env:{},execute:()=>assert.fail('must not launch')}),/Diagnostic/)
    assert.equal(existsSync(f.output),false)
  }
})

test('rejects tracing and source overrides without stripping environment variables',()=>{
  for(const name of ['SDK_TRACE_UTF8','SDK_TRACE_WORKER_SCHEDULING','SDK_OWNED_PROFILE','SDK_STANDARD_PROFILE','SDK_CAPTURE_PREVIEW_MODULES','SDK_FRAMEWORK_EXAMPLE_SOURCE','MOZ_PROFILER_STARTUP','MOZ_LOG','PWDEBUG']){
    const env={[name]:'1',PATH:'unchanged'}
    assert.throws(()=>assertPlainDesktopEnvironment(env),new RegExp(name))
    assert.equal(env[name],'1');assert.equal(env.PATH,'unchanged')
  }
  assert.doesNotThrow(()=>assertPlainDesktopEnvironment({SDK_BUILD_PROFILE:'plain',PATH:'unchanged'}))
})

test('command error followed by exit settles once and preserves the launch error',async t=>{
  const f=fixture(t),child=new EventEmitter(),failure=Error('launch failed')
  const pending=runCommand('unused',[],{cwd:f.sdk,env:{},log:join(f.sdk,'command.log')},()=>child)
  child.emit('error',failure)
  assert.doesNotThrow(()=>child.emit('exit',0,null))
  await assert.rejects(pending,error=>error===failure)
})

test('command synchronous launch error is retained and successful exit settles once',async t=>{
  const f=fixture(t),failure=Error('synchronous launch failed')
  await assert.rejects(runCommand('unused',[],{cwd:f.sdk,env:{},log:join(f.sdk,'failed.log')},()=>{throw failure}),error=>error===failure)
  const child=new EventEmitter(),pending=runCommand('unused',[],{cwd:f.sdk,env:{},log:join(f.sdk,'success.log')},()=>child)
  child.emit('exit',0,null)
  assert.doesNotThrow(()=>child.emit('error',Error('late event')))
  assert.deepEqual(await pending,{code:0,signal:null})
})
