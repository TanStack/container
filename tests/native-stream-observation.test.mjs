import test from 'node:test'
import assert from 'node:assert/strict'
import {runInNewContext} from 'node:vm'
import {installNativeStreamObservation} from '../scripts/native-stream-observation.mjs'

function fixture(origin='https://preview.invalid'){
  const listeners={},streams=[{textContent:''},{textContent:''}]
  let mutation,disconnected=false,now=0
  class Element{closest(){return true}}
  const context={location:{origin},performance:{now:()=>now},Element,
    document:{visibilityState:'visible',querySelector:()=>({querySelectorAll:()=>streams}),
      addEventListener:(name,listener)=>listeners[name]=listener},
    addEventListener:(name,listener)=>listeners[name]=listener,
    MutationObserver:class{constructor(callback){mutation=callback}observe(){}disconnect(){disconnected=true}},
  }
  runInNewContext(`(${installNativeStreamObservation.toString()})({previewOrigin:'https://preview.invalid'})`,context)
  return {context,listeners,streams,setTime:value=>now=value,mutate:()=>mutation?.(),
    click:()=>listeners.click?.({target:new Element}),disconnected:()=>disconnected}
}

test('stream evidence records early and final DOM updates without reading response data',()=>{
  const f=fixture();f.setTime(100);f.click()
  f.setTime(600);f.streams[0].textContent='Number #1: 42';f.mutate();f.mutate()
  f.setTime(5100);f.streams[0].textContent+='\nNumber #10: 12';f.mutate()
  const rows=JSON.parse(JSON.stringify(f.context.__nativeStreamObservation))
  assert.deepEqual(rows.map(row=>({kind:row.kind,time:row.elapsedMs,first:row.streams[0].first,last:row.streams[0].last})),[
    {kind:'click',time:0,first:0,last:0},{kind:'mutation',time:500,first:1,last:0},
    {kind:'mutation',time:5000,first:1,last:1},
  ])
  assert.ok(rows.every(row=>row.visibility==='visible'))
  assert.ok(!JSON.stringify(rows).includes('42'))
  f.listeners.pagehide();assert.ok(f.disconnected())
})

test('observer stays inside the requested preview and caps its retained evidence',()=>{
  const foreign=fixture('https://owner.invalid')
  assert.equal(foreign.context.__nativeStreamObservation,undefined)
  assert.deepEqual(Object.keys(foreign.listeners),[])
  const f=fixture()
  for(let run=0;run<400;run++){f.click();f.streams[0].textContent+='Number #1: 7';f.mutate()}
  assert.equal(f.context.__nativeStreamObservation.length,256)
})
