import test from 'node:test'
import assert from 'node:assert/strict'
import {runInNewContext} from 'node:vm'
import {installNativePreviewClickListenerObservation} from '../scripts/native-preview-click-listener-observation.mjs'

function fixture({origin='https://preview.invalid',maxEvents=128,consoleThrows=false}={}){
  const calls=[]
  let result,error
  class Target{
    addEventListener(...args){calls.push({method:'add',receiver:this,args});if(error)throw error;return result}
    removeEventListener(...args){calls.push({method:'remove',receiver:this,args});if(error)throw error;return result}
  }
  class Element extends Target{tagName='BUTTON'}
  const document=new Target()
  const originalAdd=Target.prototype.addEventListener,originalRemove=Target.prototype.removeEventListener
  const context={location:{origin},performance:{now:()=>42,timeOrigin:1000},document,
    EventTarget:Target,Event,HTMLElement:Element,console:{info(){if(consoleThrows)throw Error('Recorder')}}}
  runInNewContext(`(${installNativePreviewClickListenerObservation.toString()})(${JSON.stringify({previewOrigin:'https://preview.invalid',maxEvents})})`,context)
  return {context,Target,Element,document,calls,originalAdd,originalRemove,
    setResult:value=>result=value,setError:value=>error=value,
    snapshot:()=>JSON.parse(JSON.stringify(context.__nativePreviewClickListenerObservation.snapshot()))}
}

test('registration passes native callbacks, receivers, arguments and results through unchanged',()=>{
  const f=fixture(),element=new f.Element(),result={},event=new Event('click'),extra={private:'secret'}
  const calls=[]
  const listener=function(...args){calls.push({receiver:this,args});return result}
  const nativeResult={};f.setResult(nativeResult)
  assert.equal(element.addEventListener('click',listener,false,extra),nativeResult)
  assert.deepEqual(f.calls[0].args,['click',listener,false,extra])
  assert.equal(f.calls[0].receiver,element)
  assert.equal(Reflect.apply(f.calls[0].args[1],element,[event,extra]),result)
  assert.equal(calls[0].receiver,element);assert.deepEqual(calls[0].args,[event,extra])
  assert.deepEqual(f.snapshot().rows.map(r=>r.kind),['installed','listener-add'])
  assert.ok(!JSON.stringify(f.snapshot()).includes('secret'))
  const thrown=Error('original')
  element.addEventListener('click',()=>{throw thrown})
  assert.throws(()=>Reflect.apply(f.calls.at(-1).args[1],element,[event]),error=>error===thrown)
  assert.equal(f.snapshot().rows.at(-1).kind,'listener-add')
})

test('callback identity is stable across duplicate registrations, event names and removal',()=>{
  const f=fixture(),element=new f.Element(),listener=()=>{},type={toString(){throw Error('Observer must not convert type')}}
  const options={get capture(){throw Error('Observer must not read options')}}
  element.addEventListener('click',listener,options)
  element.addEventListener('click',listener,options)
  element.addEventListener(type,listener,options)
  element.addEventListener('other',listener,options)
  element.removeEventListener('click',listener,options)
  for(const row of f.calls){assert.equal(row.args[1],f.calls[0].args[1]);assert.equal(row.args[2],options)}
  assert.equal(f.calls[2].args[0],type)
  assert.equal(f.snapshot().rows.filter(r=>r.kind==='listener-add').length,2)
  assert.equal(f.snapshot().rows.filter(r=>r.kind==='listener-remove').length,1)
})

test('object listeners and unrelated events keep native handling',()=>{
  const f=fixture(),element=new f.Element(),listener={get handleEvent(){throw Error('Do not inspect')}}
  element.addEventListener('click',listener);element.removeEventListener('click',listener)
  assert.equal(f.calls[0].args[1],listener);assert.equal(f.calls[1].args[1],listener)
  let calls=0
  element.addEventListener('message',()=>{calls++;return 7})
  const before=f.snapshot()
  assert.equal(Reflect.apply(f.calls.at(-1).args[1],element,[new Event('message')]),7)
  assert.equal(calls,1);assert.deepEqual(f.snapshot(),before)
})

test('stopping restores owned methods without changing registered callbacks or native errors',()=>{
  const f=fixture({maxEvents:2,consoleThrows:true}),element=new f.Element(),listener=()=>11
  element.addEventListener('click',listener);element.addEventListener('click',listener)
  assert.equal(f.snapshot().dropped,1)
  const before=f.snapshot(),wrapped=f.calls[0].args[1]
  f.context.__nativePreviewClickListenerObservation.stop()
  assert.equal(f.Target.prototype.addEventListener,f.originalAdd)
  assert.equal(f.Target.prototype.removeEventListener,f.originalRemove)
  element.removeEventListener('click',listener)
  assert.equal(f.calls.at(-1).args[1],wrapped)
  assert.equal(Reflect.apply(wrapped,element,[new Event('click')]),11)
  element.addEventListener('click',listener)
  assert.equal(f.calls.at(-1).args[1],wrapped);assert.deepEqual(f.snapshot(),before)
  const error=Error('native add failed');f.setError(error)
  assert.throws(()=>element.addEventListener('click',listener),value=>value===error)
  assert.throws(()=>element.removeEventListener('click',listener),value=>value===error)
})

test('snapshots are detached, other origins untouched and invalid limits reject',()=>{
  const f=fixture(),snapshot=f.context.__nativePreviewClickListenerObservation.snapshot()
  snapshot.rows[0].kind='changed';assert.equal(f.snapshot().rows[0].kind,'installed')
  const outside=fixture({origin:'https://owner.invalid'})
  assert.equal(outside.context.__nativePreviewClickListenerObservation,undefined)
  assert.equal(outside.Target.prototype.addEventListener,outside.originalAdd)
  assert.equal(outside.Target.prototype.removeEventListener,outside.originalRemove)
  assert.throws(()=>fixture({maxEvents:0}),/Invalid click listener/)
})

test('stop does not replace a newer observer installed by another caller',()=>{
  const f=fixture(),newAdd=function(){},newRemove=function(){}
  f.Target.prototype.addEventListener=newAdd;f.Target.prototype.removeEventListener=newRemove
  f.context.__nativePreviewClickListenerObservation.stop()
  assert.equal(f.Target.prototype.addEventListener,newAdd)
  assert.equal(f.Target.prototype.removeEventListener,newRemove)
})
