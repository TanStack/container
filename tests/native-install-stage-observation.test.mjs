import test from 'node:test'
import assert from 'node:assert/strict'
import {runInNewContext} from 'node:vm'
import {installNativeInstallStageSummary,nativeInstallTraceResponse} from '../scripts/native-install-stage-observation.mjs'

test('trace routing covers exact catalog workers and preserves all other response buffers',()=>{
  const bytes=Buffer.from('self.loaded=true;')
  const paths=new Set(['/runtime/native/engine.js','/runtime/native/vite-8.3.2-rolldown-1.2.12/engine.js'])
  for(const path of paths){
    assert.equal(nativeInstallTraceResponse(path,bytes,paths,false),bytes)
    const instrumented=nativeInstallTraceResponse(path,bytes,paths,true)
    assert.ok(instrumented.endsWith(bytes.toString()))
    const context={performance:{now:()=>1},postMessage(){},console:{info(){}}}
    context.self=context
    runInNewContext(instrumented,context)
    assert.equal(context.loaded,true)
    assert.equal(typeof context.__sandboxInstallPhaseTrace,'function')
  }
  for(const path of ['/runtime/native/compiler.js','/runtime/native/vite-8.3.2-rolldown-1.2.12/child.js','/runtime/native/missing/engine.js'])
    assert.equal(nativeInstallTraceResponse(path,bytes,paths,true),bytes)
  assert.equal(bytes.toString(),'self.loaded=true;')
})

test('summary pairs overlapping phases, reports pending ages and forwards messages unchanged',()=>{
  const calls=[],summaries=[],receiver={private:'receiver'},argument={private:'transfer'},result={private:'result'}
  const context={performance:{now:()=>100},console:{info:text=>summaries.push(JSON.parse(text.slice('INSTALL_PHASE_SUMMARY '.length)))},
    postMessage(...args){calls.push({receiver:this,args});return result}}
  context.self=context
  runInNewContext(`(${installNativeInstallStageSummary.toString()})()`,context)
  const send=(traceId,stage,state,at)=>context.postMessage.call(receiver,{type:'sandbox-install-stage',channel:'phase',traceId,stage,state,at},argument)
  send(1,'archive-download','begin',10);send(2,'archive-download','begin',20)
  send(1,'archive-download','end',40);send(3,'package-file-write','begin',50)
  send(3,'package-file-write','error',70)
  for(const completed of [1,19,20,21,39,40]){
    const message={type:'native-dev-progress',phase:`dependency-installed:${completed}/132`}
    assert.equal(context.postMessage.call(receiver,message,argument),result)
    assert.equal(calls.at(-1).args[0],message)
  }
  assert.equal(summaries.length,2)
  assert.deepEqual(summaries[0].stages['archive-download'],{count:1,totalMs:30,maxMs:30,errors:0})
  assert.deepEqual(summaries[0].stages['package-file-write'],{count:1,totalMs:20,maxMs:20,errors:1})
  assert.deepEqual(summaries[0].pendingStages,{'archive-download':{count:1,maxAgeMs:80}})
  context.postMessage({type:'sandbox-install-stage',channel:'phase',state:'limit'})
  context.postMessage({type:'native-dev-progress',phase:'dependencies-installed'})
  assert.equal(summaries.at(-1).limited,true)
  assert.ok(calls.slice(0,-2).every(call=>call.receiver===receiver&&call.args[1]===argument))
  assert.equal(JSON.stringify(summaries).includes('private'),false)
})

test('summary delivery errors do not change the native result or thrown error',()=>{
  const result={},failure=Error('native failure')
  const context={performance:{now:()=>1},console:{info(){throw Error('observer failure')}},
    postMessage(message){if(message.fail)throw failure;return result}}
  context.self=context
  runInNewContext(`(${installNativeInstallStageSummary.toString()})()`,context)
  assert.equal(context.postMessage({type:'native-dev-progress',phase:'dependencies-installed'}),result)
  assert.throws(()=>context.postMessage({type:'native-dev-progress',phase:'dependencies-installed',fail:true}),error=>error===failure)
})
