import test from 'node:test'
import assert from 'node:assert/strict'
import {runInNewContext} from 'node:vm'
import {installNativeInstallFilesystemObservation} from '../scripts/native-install-filesystem-observation.mjs'

test('filesystem timing preserves receivers, arguments, results and errors, then restores methods',()=>{
  const calls=[],summaries=[],result={},failure=Error('ENOENT'),argument={private:'argument'},transfer={}
  let clock=0
  const original={
    lstatSync(...args){calls.push({receiver:this,args});clock+=2;throw failure},
    mkdirSync(...args){calls.push({receiver:this,args});clock+=3;return result},
    writeFileSync(...args){calls.push({receiver:this,args});clock+=5;return result},
  }
  const vol={...original},forwarded=[],context={performance:{now:()=>clock},
    console:{info:text=>summaries.push(JSON.parse(text.slice('INSTALL_FILESYSTEM_SUMMARY '.length)))},
    postMessage(...args){forwarded.push({receiver:this,args});return result}}
  context.self=context
  context[Symbol.for('tanstack-container:filesystem-provider-v1')]={vol}
  runInNewContext(`(${installNativeInstallFilesystemObservation.toString()})()`,context)
  const receiver={},start={type:'native-dev-progress',phase:'dependencies-install-started'}
  assert.equal(context.postMessage.call(receiver,start,transfer),result)
  assert.notEqual(vol.lstatSync,original.lstatSync)
  assert.throws(()=>vol.lstatSync(argument),error=>error===failure)
  assert.equal(vol.mkdirSync(argument),result)
  assert.equal(vol.writeFileSync(argument),result)
  assert.ok(calls.every(call=>call.receiver===vol&&call.args[0]===argument))
  context.postMessage({type:'native-dev-progress',phase:'dependency-installed:19/132'})
  assert.equal(summaries.length,0)
  context.postMessage({type:'native-dev-progress',phase:'dependency-installed:20/132'})
  assert.deepEqual(summaries[0].operations,{
    lstatSync:{count:1,totalMs:2,maxMs:2,errors:1},
    mkdirSync:{count:1,totalMs:3,maxMs:3,errors:0},
    writeFileSync:{count:1,totalMs:5,maxMs:5,errors:0},
  })
  context.postMessage({type:'native-dev-progress',phase:'dependencies-installed'})
  for(const name of Object.keys(original))assert.equal(vol[name],original[name])
  assert.equal(forwarded[0].receiver,receiver)
  assert.equal(forwarded[0].args[0],start)
  assert.equal(forwarded[0].args[1],transfer)
  assert.equal(JSON.stringify(summaries).includes('private'),false)
})

test('missing providers and failed summary delivery do not change message behavior',()=>{
  const result={},context={console:{info(){throw Error('observation failed')}},postMessage(){return result}}
  context.self=context
  runInNewContext(`(${installNativeInstallFilesystemObservation.toString()})()`,context)
  for(const phase of ['dependencies-install-started','dependency-installed:20/132','dependencies-installed'])
    assert.equal(context.postMessage({type:'native-dev-progress',phase}),result)
})
