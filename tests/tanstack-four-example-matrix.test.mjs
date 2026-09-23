import test from 'node:test'
import assert from 'node:assert/strict'
import {runMatrix} from '../scripts/run-tanstack-four-example-matrix.mjs'

function harness(fail){
  const events=[]
  const ops={
    startPreview:async()=>{events.push('preview');return 'preview'},
    readyPreview:async()=>{events.push('preview-ready');if(fail==='preview')throw Error('failed')},
    startOwner:async row=>{events.push('owner:'+row.id);return row.id},
    readyOwner:async owner=>{events.push('ready:'+owner);if(fail==='owner')throw Error('failed')},
    runCell:async(row,browser)=>{events.push(row.id+':'+browser);if(fail==='cell')throw Error('failed')},
    stop:async handle=>events.push('stop:'+handle),
  }
  return {events,ops}
}
test('matrix serializes all eight cells and owns server lifetimes',async()=>{
  const {events,ops}=harness()
  await runMatrix({examples:['a','b','c','d'].map(id=>({id}))},ops)
  assert.deepEqual(events,['preview','preview-ready',...['a','b','c','d'].flatMap(id=>['owner:'+id,'ready:'+id,id+':chromium',id+':firefox','stop:'+id]),'stop:preview'])
})
for(const failure of ['preview','owner','cell'])test('failure stops owned handles: '+failure,async()=>{
  const {events,ops}=harness(failure)
  await assert.rejects(runMatrix({examples:[{id:'a'},{id:'b'}]},ops),/failed/)
  assert.equal(events.at(-1),'stop:preview')
  if(failure!=='preview')assert.equal(events.at(-2),'stop:a')
  assert.ok(!events.includes('owner:b'))
})
