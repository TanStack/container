import test from 'node:test'
import assert from 'node:assert/strict'
import {runInNewContext} from 'node:vm'
import {installNativeFilesystemTrafficObservation,nativeFilesystemTrafficResponse} from '../scripts/native-filesystem-traffic-observation.mjs'

const key=Symbol.for('tanstack-container:filesystem-traffic-observation-v1')
function setup({fs={},vol=fs,consoleThrows=false,url='https://owner.test/runtime/native/engine.js',limits={}}={}){
  let clock=0,timer,cleared=false
  const calls=[],rows=[],result={},failure=Error('native post failure')
  const original=function(...args){calls.push({receiver:this,args});if(args[0]?.fail)throw failure;return result}
  const context={URL,location:{href:url},performance:{now:()=>clock},
    console:{info(text){if(consoleThrows)throw Error('observer failed');rows.push(JSON.parse(text.slice('FILESYSTEM_TRAFFIC_SUMMARY '.length)))}},
    setTimeout(fn){timer=fn;return 1},clearTimeout(){cleared=true},postMessage:original}
  context.self=context
  context[Symbol.for('tanstack-container:filesystem-provider-v1')]={fs,vol}
  runInNewContext(`(${installNativeFilesystemTrafficObservation.toString()})(${JSON.stringify(limits)})`,context)
  return {context,calls,rows,result,failure,original,tick:ms=>{clock+=ms},timeout:()=>timer(),cleared:()=>cleared,
    phase:name=>context.postMessage({type:'native-dev-progress',phase:name}),stop:()=>context[key]?.stop('first-request-ready')}
}

test('exact response routing leaves disabled and unrelated buffers identical',()=>{
  const bytes=Buffer.from('self.loaded=true;'),paths=new Set(['/runtime/native/engine.js'])
  assert.equal(nativeFilesystemTrafficResponse('/runtime/native/engine.js',bytes,paths,false),bytes)
  assert.equal(nativeFilesystemTrafficResponse('/runtime/native/compiler.js',bytes,paths,true),bytes)
  const source=nativeFilesystemTrafficResponse('/runtime/native/engine.js',bytes,paths,true)
  assert.ok(source.endsWith(bytes.toString()))
  assert.equal(bytes.toString(),'self.loaded=true;')
})

test('timing preserves native calls, receivers, results, errors and descriptors without private data',()=>{
  const nativeCalls=[],argument={private:'secret'},value={},missing=Object.assign(Error('private filename'),{code:'ENOENT'})
  let h
  const fs={statSync(...args){nativeCalls.push({receiver:this,args});h.tick(2);if(args[0]===argument)throw missing;return undefined},
    existsSync(){h.tick(3);return false},readFileSync(){h.tick(5);return value}}
  fs.realpathSync=Object.assign(function(path){return path},{native:null});fs.realpathSync.native=fs.realpathSync
  const vol={...fs},before=Object.getOwnPropertyDescriptors(fs)
  h=setup({fs,vol});h.phase('filesystem-connected')
  assert.equal(fs.statSync,vol.statSync)
  assert.equal(fs.realpathSync.native,fs.realpathSync)
  assert.equal(fs.realpathSync.name,before.realpathSync.value.name)
  assert.equal(fs.realpathSync.length,before.realpathSync.value.length)
  assert.throws(()=>fs.statSync(argument),error=>error===missing)
  assert.equal(vol.statSync('/not-logged'),undefined)
  assert.equal(fs.existsSync('/not-logged'),false)
  assert.equal(fs.readFileSync('/not-logged'),value)
  h.phase('config-runner-ready');h.stop()
  assert.equal(nativeCalls[0].receiver,fs);assert.equal(nativeCalls[0].args[0],argument)
  assert.equal(nativeCalls[1].receiver,vol)
  assert.deepEqual(h.rows[0].stages.bootstrap.statSync,{count:2,totalMs:4,maxMs:2,errors:1,notFound:2})
  assert.deepEqual(h.rows[0].stages.bootstrap.existsSync,{count:1,totalMs:3,maxMs:3,errors:0,notFound:1})
  assert.deepEqual(Object.getOwnPropertyDescriptors(fs),before)
  assert.equal(vol.statSync,before.statSync.value)
  assert.equal(h.context.postMessage,h.original);assert.ok(h.cleared())
  assert.equal(h.rows.at(-1).complete,true)
  assert.equal(JSON.stringify(h.rows).includes('private'),false)
  assert.equal(JSON.stringify(h.rows).includes('not-logged'),false)
})

test('postMessage receiver, transfer list, return value and thrown object stay unchanged',()=>{
  const h=setup(),receiver={},transfer={}
  const message={type:'native-dev-progress',phase:'filesystem-connected'}
  assert.equal(h.context.postMessage.call(receiver,message,transfer),h.result)
  assert.equal(h.calls[0].receiver,receiver);assert.equal(h.calls[0].args[0],message);assert.equal(h.calls[0].args[1],transfer)
  assert.throws(()=>h.context.postMessage({fail:true}),error=>error===h.failure)
  h.stop()
})

test('summary failures and a broken observation clock cannot replace native results or errors',()=>{
  const result={},failure=Error('native call failure'),fs={readFileSync(){return result},statSync(){throw failure}}
  const h=setup({fs,consoleThrows:true});h.phase('filesystem-connected')
  h.context.performance.now=()=>{throw Error('clock failed')}
  assert.equal(fs.readFileSync('secret'),result)
  assert.throws(()=>fs.statSync('secret'),error=>error===failure)
  h.stop();assert.equal(h.context.postMessage,h.original)
})

test('operation, duration and summary limits restore methods and report incomplete captures',()=>{
  for(const mode of ['operation','duration']){
    const original=()=>true,fs={existsSync:original},h=setup({fs,limits:{maxOperations:3,maxSummaries:2}})
    h.phase('filesystem-connected')
    for(const phase of ['dependencies-install-started','dependencies-installed','config-runner-ready','config-loaded'])h.phase(phase)
    assert.equal(fs.existsSync('secret'),true)
    if(mode==='operation'){fs.existsSync('secret');fs.existsSync('secret')}
    else h.timeout()
    assert.equal(fs.existsSync,original);assert.ok(h.cleared());assert.equal(h.rows.length,2)
    assert.equal(h.rows.at(-1).complete,false);assert.equal(h.rows.at(-1).reason,mode+'-limit')
    const count=h.rows.at(-1).operations;fs.existsSync('secret');assert.equal(h.rows.at(-1).operations,count)
  }
})

test('restoration does not overwrite a later method or postMessage replacement',()=>{
  const fs={existsSync:()=>true},h=setup({fs}),replacement=()=>false,post=()=>42
  h.phase('filesystem-connected');fs.existsSync=replacement;h.context.postMessage=post;h.stop()
  assert.equal(fs.existsSync,replacement);assert.equal(h.context.postMessage,post)
})

test('compiler or child query URLs are untouched, repeated installation is harmless',()=>{
  for(const url of ['https://owner.test/engine.js?native-thread=1','https://owner.test/engine.js?native-command=1']){
    const h=setup({url});assert.equal(h.context.postMessage,h.original);assert.equal(h.context[key],undefined)
  }
  const h=setup(),post=h.context.postMessage
  runInNewContext(`(${installNativeFilesystemTrafficObservation.toString()})()`,h.context)
  assert.equal(h.context.postMessage,post);h.phase('filesystem-connected');h.stop()
})

test('missing or immutable providers do not change native message delivery',()=>{
  const h=setup();delete h.context[Symbol.for('tanstack-container:filesystem-provider-v1')]
  assert.equal(h.phase('filesystem-connected'),h.result);assert.equal(h.rows[0].reason,'provider-missing')
  const original=()=>true,fs={existsSync:original};Object.freeze(fs)
  const immutable=setup({fs});assert.equal(immutable.phase('filesystem-connected'),immutable.result)
  assert.equal(fs.existsSync,original);assert.equal(immutable.rows.at(-1).reason,'setup-error')
})
