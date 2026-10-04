import test from 'node:test'
import assert from 'node:assert/strict'
import {verifyNativeOwnerWorkflow,verifyNativeCallbackInput,verifyNativeFilesystemInput,nativeWorkflowConcurrency,scheduleNativeWorkflows,runNativeWorkflowChild} from '../scripts/probe-native-owner-workflows.mjs'
import {readFileSync} from 'node:fs'

const examples=['TanStack Start counter','TanStack Start basic','TanStack Start streaming',
  'TanStack Router file-based SSR','Solid Start counter']
const rows=()=>examples.map(example=>({browser:'firefox',example,development:'passed'}))
const output=rows=>rows.map(row=>JSON.stringify(row)).join('\n')

test('workflow accounting requires exactly the full pinned five-example set',()=>{
  assert.equal(verifyNativeOwnerWorkflow('progress\n'+output(rows()),'firefox').length,5)
  for(const change of [r=>r.pop(),r=>r.push(r[0]),r=>r[1].example=r[0].example,
    r=>r[1].development='failed',r=>r[1].browser='chromium',r=>r[1].example='Other app']){
    const value=rows();change(value)
    assert.throws(()=>verifyNativeOwnerWorkflow(output(value),'firefox'))
  }
})

test('unrelated browser output and malformed or incomplete records cannot pass',()=>{
  assert.throws(()=>verifyNativeOwnerWorkflow(output(rows()),'unsupported'))
  assert.throws(()=>verifyNativeOwnerWorkflow('progress\n{}\n{broken','firefox'))
  assert.throws(()=>verifyNativeOwnerWorkflow(output(rows().slice(0,4))+'\n'+JSON.stringify({development:true}),'firefox'))
})

test('callback mode refuses normal engines and diagnostic claims without emitted instrumentation',()=>{
  const inventory={diagnostics:{vitePrivateCallbackTrace:true}}
  const markers='finishPrivateImport observePrivateImport privateImportOutcome'
  assert.doesNotThrow(()=>verifyNativeCallbackInput(inventory,markers))
  for(const invalid of [null,{}, {diagnostics:{}},{diagnostics:{vitePrivateCallbackTrace:false}}])
    assert.throws(()=>verifyNativeCallbackInput(invalid,markers),/instrumented diagnostic build/)
  for(const marker of markers.split(' '))
    assert.throws(()=>verifyNativeCallbackInput(inventory,markers.replace(marker,'')),/absent/)
})

test('filesystem mode requires both the diagnostic inventory and emitted trace',()=>{
  const inventory={diagnostics:{wasiFilesystemReplyTrace:true}}
  assert.doesNotThrow(()=>verifyNativeFilesystemInput(inventory,'wasi-fs-reply:'))
  for(const invalid of [null,{}, {diagnostics:{}},{diagnostics:{wasiFilesystemReplyTrace:false}}])
    assert.throws(()=>verifyNativeFilesystemInput(invalid,'wasi-fs-reply:'),/diagnostic build/)
  assert.throws(()=>verifyNativeFilesystemInput(inventory,''),/absent/)
})

test('example progress capture does not depend on enabling Vite or module tracing',()=>{
  const source=readFileSync(new URL('./native-owner-sdk.test.mjs',import.meta.url),'utf8')
  assert.ok(source.includes('if(moduleTrace||viteTrace||progressTrace)client.subscribeEvents'))
  assert.ok(source.includes("progressTrace:process.env.NATIVE_OWNER_TRACE==='1'"))
})

test('listener capture remains opt-in and failed captures report bounded-tail loss',()=>{
  const driver=readFileSync(new URL('../scripts/probe-native-owner-workflows.mjs',import.meta.url),'utf8')
  const testSource=readFileSync(new URL('./native-owner-sdk.test.mjs',import.meta.url),'utf8')
  assert.ok(driver.includes("NATIVE_OWNER_CLICK_LISTENER_OBSERVE:listenerMode?'1':'0'"))
  assert.ok(driver.includes("mode==='repeat-listeners'?[catalog[1],catalog[1],catalog[1]]"))
  assert.ok(testSource.includes("if(process.env.NATIVE_OWNER_CLICK_LISTENER_OBSERVE==='1')"))
  assert.ok(testSource.includes('previewClickListenersDropped++'))
  assert.ok(testSource.includes('previewClickListeners,previewClickListenersDropped'))
})

const child=(source,options={})=>runNativeWorkflowChild(process.execPath,['-e',source],{},options)

test('only desktop enables bounded concurrency; default and observations remain sequential',()=>{
  assert.equal(nativeWorkflowConcurrency('desktop'),1)
  assert.equal(nativeWorkflowConcurrency('desktop',3),3)
  for(const mode of ['repeat-desktop','callbacks','filesystem','interactions','listeners','repeat-listeners'])
    assert.equal(nativeWorkflowConcurrency(mode,3),1)
  for(const value of [0,4,1.5,NaN,'2'])assert.throws(()=>nativeWorkflowConcurrency('desktop',value))
})

test('bounded real child scheduling preserves order and reduces fixture wall time',async()=>{
  const measure=async concurrency=>{
    let active=0,peak=0
    const start=Date.now()
    const rows=await scheduleNativeWorkflows([0,1,2],{concurrency,run:async(plan,index,signal)=>{
      active++;peak=Math.max(peak,active)
      const result=await child('setTimeout(()=>console.log("done"),250)',{signal})
      active--;assert.equal(result.status,0);assert.equal(result.stdout,'done\n')
      return {passed:true,index}
    }})
    assert.deepEqual(rows.map(row=>row.index),[0,1,2]);assert.equal(active,0)
    assert.equal(peak,concurrency)
    return Date.now()-start
  }
  const sequential=await measure(1),concurrent=await measure(3)
  console.log(JSON.stringify({fixture:'three 250ms Node children',sequentialMs:sequential,concurrentMs:concurrent}))
  assert.ok(concurrent<sequential,'Concurrent fixtures should finish sooner')
})

test('failed child cancels and drains sibling without starting queued work',async()=>{
  const started=[]
  const rows=await scheduleNativeWorkflows([0,1,2],{concurrency:2,run:async(plan,index,signal)=>{
    started.push(index)
    const result=await child(index===0?'setTimeout(()=>process.exit(7),100)':'setInterval(()=>{},1000)',{signal})
    return {passed:result.status===0,result}
  }})
  assert.deepEqual(started,[0,1]);assert.equal(rows.length,2)
  assert.equal(rows[0].result.status,7);assert.ok(rows[1].result.error)
})

test('timeout escalates for a child ignoring SIGTERM and output stays bounded',async()=>{
  const result=await child('process.on("SIGTERM",()=>{});setInterval(()=>{},1000)',{timeout:150,killGraceMs:50})
  assert.match(String(result.error),/timed out/);assert.equal(result.signal,'SIGKILL')
  const noisy=await child('process.stdout.write("x".repeat(10000));setInterval(()=>{},1000)',{maxBuffer:100})
  assert.match(String(noisy.error),/maxBuffer/);assert.equal(Buffer.byteLength(noisy.stdout),100)
})

test('spawn errors and pre-aborted schedules cannot pass',async()=>{
  const result=await runNativeWorkflowChild('/missing/native-workflow-child',[],{})
  assert.ok(result.error);assert.equal(result.status,-2)
  const controller=new AbortController();controller.abort()
  assert.deepEqual(await scheduleNativeWorkflows([0],{signal:controller.signal,run:()=>assert.fail('must not start')}),[])
})

test('external abort drains children; a thrown task also drains its sibling',async()=>{
  const controller=new AbortController()
  const timer=setTimeout(()=>controller.abort(Error('fixture interrupt')),100)
  const rows=await scheduleNativeWorkflows([0,1,2],{concurrency:2,signal:controller.signal,run:async(_,index,signal)=>{
    const result=await child('setInterval(()=>{},1000)',{signal})
    return {passed:false,result}
  }})
  clearTimeout(timer);assert.equal(rows.length,2)
  for(const row of rows)assert.match(String(row.result.error),/fixture interrupt/)
  let drained=false
  await assert.rejects(scheduleNativeWorkflows([0,1,2],{concurrency:2,run:async(_,index,signal)=>{
    if(index===0){await new Promise(resolve=>setTimeout(resolve,100));throw Error('receipt failure')}
    await child('setInterval(()=>{},1000)',{signal});drained=true;return {passed:false}
  }}),/receipt failure/)
  assert.equal(drained,true)
})


test('process-group cleanup removes a descendant after its parent exits',{
  skip:process.platform==='win32'?'POSIX process group control':false,
},async()=>{
  const result=await child(`const {spawn}=require('node:child_process');
    const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    console.log(descendant.pid);descendant.unref();setTimeout(()=>process.exit(0),100)`)
  assert.equal(result.status,0)
  const pid=Number(result.stdout.trim());assert.ok(pid>0)
  let gone=false
  for(let attempt=0;attempt<50;attempt++){
    try{process.kill(pid,0)}catch(error){assert.equal(error.code,'ESRCH');gone=true;break}
    await new Promise(resolve=>setTimeout(resolve,10))
  }
  assert.equal(gone,true,'Descendant must not survive completed workflow')
})
