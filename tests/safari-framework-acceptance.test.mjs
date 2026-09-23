import assert from 'node:assert/strict'
import test from 'node:test'
import {runInNewContext} from 'node:vm'
import {retainSafariDriverStderr,assertSafariAppStopped,runSafariFrameworkScript,assertSafariPointerVisibility,classifySafariCapacityFailure,installSafariPointerProbe,parseSafariWebContentProcesses,runSafariFrameworkAcceptance,safariPreviewIsAbsent,withSafariCleanup} from '../scripts/safari-framework-acceptance.mjs'

test('driver stderr retention distinguishes unavailable from empty and bounds copied output',()=>{
  assert.deepEqual(retainSafariDriverStderr(),{available:false,limitCharacters:16384})
  assert.deepEqual(retainSafariDriverStderr(()=>''),{available:true,limitCharacters:16384,stderr:''})
  let text='x'.repeat(20000)+'tail'
  const retained=retainSafariDriverStderr(()=>text)
  text='later'
  assert.equal(retained.stderr.length,16384)
  assert.ok(retained.stderr.endsWith('tail'))
})

test('Safari script checks wait for a fresh completion and retain observed output',async()=>{
  let clicked=false,reads=0
  const records={}
  const previous='test exited with status 0\n'
  const driver={find:async selector=>selector,property:async()=> 'test',
    execute:async(_code,[selector])=>{assert.equal(selector,'#run-script');clicked=true;return true},
    text:async()=>{if(!clicked)return previous;return ++reads===1?previous:previous+'test exited with status 1\n'}}
  const result=await runSafariFrameworkScript(driver,1,records,'negative')
  assert.equal(reads,2)
  assert.deepEqual(result,{selectedScript:'test',expectedExitStatus:1,beforeCount:1,status:'passed',exitStatus:1,output:previous+'test exited with status 1\n',afterCount:2})
  assert.equal(records.negative,result)
})

test('Safari script mismatch keeps the actual failed result',async()=>{
  let clicked=false
  const records={}
  const driver={find:async selector=>selector,property:async()=> 'test',execute:async()=>{clicked=true;return true},text:async()=>clicked?'test exited with status 1\n':''}
  await assert.rejects(runSafariFrameworkScript(driver,0,records,'restored'),/Expected restored test exit 0, received 1/)
  assert.equal(records.restored.exitStatus,1)
  assert.equal(records.restored.status,'failed')
  assert.equal(records.restored.output,'test exited with status 1\n')
})

test('Safari stop waits for App stopped before accepting iframe removal',async()=>{
  const calls=[]
  let reads=0
  await assertSafariAppStopped({
    find:async selector=>{calls.push(selector);if(selector==='#preview iframe')throw Object.assign(Error('absent'),{code:'no such element'});return selector},
    text:async()=>++reads===1?'Stopping':'App stopped',
  })
  assert.deepEqual(calls,['#output','#output','#preview iframe'])
})

test('Safari preview shutdown is false while its iframe exists',async()=>{
  assert.equal(await safariPreviewIsAbsent({find:async selector=>{assert.equal(selector,'#preview iframe');return {element:'preview'}}}),false)
})

test('Safari preview shutdown is true only for a missing iframe',async()=>{
  assert.equal(await safariPreviewIsAbsent({find:async()=>{throw Object.assign(Error('iframe is absent'),{code:'no such element'})}}),true)
})

for(const code of ['ERR_SAFARI_WEBDRIVER_TIMEOUT','invalid session id']){
  test(`Safari preview shutdown does not pass on ${code}`,async()=>{
    const failure=Object.assign(Error('iframe lookup failed'),{code})
    await assert.rejects(safariPreviewIsAbsent({find:async()=>{throw failure}}),error=>error===failure)
  })
}

test('Safari cleanup runs once after a successful body and preserves its result',async()=>{
  const calls=[]
  const result=await withSafariCleanup(async()=>{calls.push('body');return 42},async()=>{calls.push('cleanup')})
  assert.equal(result,42)
  assert.deepEqual(calls,['body','cleanup'])
})

test('Safari cleanup failure is thrown when the body succeeds',async()=>{
  const cleanupError=Error('frame/parent timed out')
  await assert.rejects(withSafariCleanup(async()=>42,async()=>{throw cleanupError}),error=>error===cleanupError)
})

test('Safari assertion failure survives successful cleanup unchanged',async()=>{
  const primaryError=Object.assign(Error('Count: 1 was not observed'),{code:'ERR_SAFARI_ACCEPTANCE_TIMEOUT'})
  let cleanups=0
  await assert.rejects(withSafariCleanup(async()=>{throw primaryError},async()=>{cleanups++}),error=>error===primaryError)
  assert.equal(cleanups,1)
  assert.equal(primaryError.message,'Count: 1 was not observed')
  assert.equal(primaryError.cleanupErrors,undefined)
})

test('Safari assertion failure stays primary with cleanup failure attached and visible in reports',async()=>{
  const primaryError=Object.assign(Error('Count: 1 was not observed'),{code:'ERR_SAFARI_ACCEPTANCE_TIMEOUT'})
  const cleanupError=Object.assign(Error('frame/parent timed out'),{code:'ERR_SAFARI_WEBDRIVER_TIMEOUT'})
  await assert.rejects(withSafariCleanup(async()=>{throw primaryError},async()=>{throw cleanupError}),error=>error===primaryError)
  assert.equal(primaryError.code,'ERR_SAFARI_ACCEPTANCE_TIMEOUT')
  assert.deepEqual(primaryError.cleanupErrors,[cleanupError])
  assert.match(String(primaryError),/Count: 1 was not observed\nSafari cleanup failed: Error: frame\/parent timed out/)
})

test('Safari cleanup does not replace falsy thrown values',async()=>{
  for(const value of [undefined,null,false,0,'']){
    let caught=false
    try{await withSafariCleanup(()=>{throw value},()=>{throw Error('cleanup failed')})}
    catch(error){caught=true;assert.equal(error,value)}
    assert.equal(caught,true)
  }
})

test('install tracing rejects missing observation before starting a consumer or server',async()=>{
  await assert.rejects(runSafariFrameworkAcceptance({traceInstall:true,instrumentCapacity:false}),/requires capacity observation/)
})

test('server-call tracing rejects missing observation before starting a consumer or server',async()=>{
  await assert.rejects(runSafariFrameworkAcceptance({tracePreviewServerCall:true,instrumentCapacity:false}),/requires capacity observation/)
})

test('pointer evidence is passive, bounded, serializable and removable',()=>{
  const listeners=new Map(),context={performance:{now:()=>123},document:{
    visibilityState:'visible',
    addEventListener(type,listener,options){
      assert.equal(options.capture,true)
      assert.equal(options.passive,true)
      listeners.set(type,listener)
    },
    removeEventListener(type,listener,capture){
      assert.equal(capture,true)
      assert.equal(listeners.get(type),listener)
      listeners.delete(type)
    },
  }}
  runInNewContext(`(${installSafariPointerProbe.toString()})()`,context)
  assert.equal(listeners.size,6)
  for(let i=0;i<100;i++)listeners.get('click')({type:'click',isTrusted:i%2===0,target:{id:'start-count'}})
  const probe=context.__safariAcceptancePointerProbe
  assert.equal(probe.events.length,16)
  assert.deepEqual(JSON.parse(JSON.stringify(probe.events[0])),{type:'click',trusted:true,target:'start-count',time:123})
  assert.equal(probe.events[1].trusted,false)
  assertSafariPointerVisibility(probe.visibility)
  context.document.visibilityState='hidden'
  listeners.get('visibilitychange')()
  context.document.visibilityState='visible'
  listeners.get('visibilitychange')()
  assert.equal(probe.visibility.current,'visible')
  assert.equal(probe.visibility.hiddenSeen,true)
  assert.throws(()=>assertSafariPointerVisibility(probe.visibility),{code:'ERR_SAFARI_NOT_VISIBLE'})
  probe.dispose()
  assert.equal(listeners.size,0)
})

test('hidden or missing interaction evidence never counts as a visible Safari pass',()=>{
  for(const evidence of [null,{}, {initial:'hidden',current:'visible',hiddenSeen:false},{initial:'visible',current:'hidden',hiddenSeen:false}]){
    assert.throws(()=>assertSafariPointerVisibility(evidence),{code:'ERR_SAFARI_NOT_VISIBLE'})
  }
  assert.equal(classifySafariCapacityFailure('ERR_SAFARI_NOT_VISIBLE',{status:'passed'}),'safari-not-visible')
})

test('parses only Safari WebContent process memory samples',()=>{
  const output=`
  27013 167584 0.2 01:02 /Applications/Safari.app/Contents/MacOS/Safari
  27016  68464 0.0 01:02 /System/Library/Frameworks/WebKit.framework/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent
  27068 6540176 5.4 00:57 /System/Library/Frameworks/WebKit.framework/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent
`
  assert.deepEqual(parseSafariWebContentProcesses(output),[
    {pid:27016,residentKiB:68464,cpuPercent:0,elapsed:'01:02',command:'/System/Library/Frameworks/WebKit.framework/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent'},
    {pid:27068,residentKiB:6540176,cpuPercent:5.4,elapsed:'00:57',command:'/System/Library/Frameworks/WebKit.framework/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent'},
  ])
})
