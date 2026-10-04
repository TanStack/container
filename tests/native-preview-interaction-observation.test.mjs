import test from 'node:test'
import assert from 'node:assert/strict'
import {runInNewContext} from 'node:vm'
import {installNativePreviewInteractionObservation} from '../scripts/native-preview-interaction-observation.mjs'

function fixture({origin='https://preview.invalid',maxEvents=64,consoleThrows=false}={}){
  const document=new EventTarget();document.readyState='loading'
  let calls=0,receiver,args,result,error
  class Element{
    tagName='BUTTON';isConnected=true;disabled=false
    click(){calls++;receiver=this;args=Array.from(arguments);if(error)throw error;return result}
  }
  const global=new EventTarget(),original=Object.getOwnPropertyDescriptor(Element.prototype,'click')
  const context={location:{origin},performance:{now:()=>42,timeOrigin:1000},document,HTMLElement:Element,
    console:{info(){if(consoleThrows)throw Error('Recorder')}},
    addEventListener:global.addEventListener.bind(global),removeEventListener:global.removeEventListener.bind(global)}
  runInNewContext(`(${installNativePreviewInteractionObservation.toString()})(${JSON.stringify({previewOrigin:'https://preview.invalid',maxEvents})})`,context)
  return {context,Element,document,global,original,counts:()=>calls,call:()=>({receiver,args}),
    setResult:value=>result=value,setError:value=>error=value,
    snapshot:()=>JSON.parse(JSON.stringify(context.__nativePreviewInteractionObservation.snapshot()))}
}

test('click observation preserves original receivers, arguments, results and errors without extra clicks',()=>{
  const f=fixture(),element=new f.Element(),result={},argument={private:'secret'}
  f.setResult(result)
  assert.equal(element.click(argument),result);assert.equal(f.counts(),1)
  assert.equal(f.call().receiver,element);assert.deepEqual(f.call().args,[argument])
  const error=Error('private message');f.setError(error)
  assert.throws(()=>element.click(),value=>value===error);assert.equal(f.counts(),2)
  assert.deepEqual(f.snapshot().rows.map(r=>r.kind),['installed','click-call','click-return','click-call','click-threw'])
  assert.ok(!JSON.stringify(f.snapshot()).includes('private'));assert.ok(!JSON.stringify(f.snapshot()).includes('secret'))
})

test('recording failures, event limits and detached snapshots cannot change click behavior',()=>{
  const f=fixture({maxEvents:2,consoleThrows:true}),element=new f.Element()
  element.click();element.click()
  assert.equal(f.counts(),2);assert.equal(f.snapshot().dropped,3)
  const snapshot=f.context.__nativePreviewInteractionObservation.snapshot();snapshot.rows[0].kind='changed'
  assert.notEqual(f.snapshot().rows[0].kind,'changed')
  f.context.__nativePreviewInteractionObservation.dispose()
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.Element.prototype,'click'),f.original)
  element.click();assert.equal(f.counts(),3);assert.equal(f.snapshot().dropped,3)
})

test('event observation records load and capture/bubble metadata, not target text or URLs',()=>{
  const f=fixture(),element=new f.Element()
  element.textContent='private';element.id='secret'
  const click=new Event('click');Object.defineProperty(click,'target',{value:element})
  f.document.dispatchEvent(click)
  f.document.readyState='complete';f.document.dispatchEvent(new Event('DOMContentLoaded'))
  const load=new Event('load');Object.defineProperty(load,'target',{value:f.document});f.global.dispatchEvent(load)
  const scriptLoad=new Event('load');Object.defineProperty(scriptLoad,'target',{value:{tagName:'SCRIPT',type:'module',src:'https://private.invalid/secret'}})
  f.document.dispatchEvent(scriptLoad)
  assert.deepEqual(f.snapshot().rows.map(r=>r.kind),['installed','click-capture','click-bubble','dom-content-loaded','window-loaded','script-load'])
  const value=JSON.stringify(f.snapshot());assert.ok(!value.includes('secret'));assert.ok(!value.includes('private'))
  assert.equal(f.counts(),0)
})

test('other origins are untouched and invalid limits reject',()=>{
  const outside=fixture({origin:'https://owner.invalid'})
  assert.equal(outside.context.__nativePreviewInteractionObservation,undefined)
  assert.deepEqual(Object.getOwnPropertyDescriptor(outside.Element.prototype,'click'),outside.original)
  assert.throws(()=>fixture({maxEvents:0}),/Invalid interaction/)
})
