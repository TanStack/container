import test from 'node:test'
import assert from 'node:assert/strict'
import {hookProfiler} from './fixtures/vite-hook-profiler.mjs'

test('hook tracing preserves receivers, metadata, values and errors',async()=>{
  const original=console.log,events=[]
  console.log=value=>events.push(JSON.parse(value.slice(11)))
  try{
    const receiver={environment:{name:'ssr'}},failure=new Error('fixture error')
    const plugin={name:'fixture',
      resolveId(id){assert.equal(this,receiver);return id},
      load:{order:'pre',handler:async function(id){assert.equal(this,receiver);return id+' loaded'}},
      transform(){throw failure},
    }
    hookProfiler().configResolved({plugins:[plugin]})
    assert.equal(plugin.resolveId.call(receiver,'module'),'module')
    assert.equal(plugin.load.order,'pre')
    assert.equal(await plugin.load.handler.call(receiver,'module'),'module loaded')
    assert.throws(()=>plugin.transform.call(receiver,'source','module'),error=>error===failure)
    assert.deepEqual(events.map(event=>event.phase),['start','end','start','end','start','error'])
    assert.ok(events.every(event=>event.environment==='ssr'))
  }finally{console.log=original}
})

test('trace cap stops logging without skipping later hooks',()=>{
  const original=console.log;let logged=0,calls=0
  console.log=()=>logged++
  try{
    const plugin={name:'fixture',load(){return ++calls}}
    hookProfiler().configResolved({plugins:[plugin]})
    for(let i=1;i<=130;i++)assert.equal(plugin.load('module'),i)
    assert.equal(logged,256);assert.equal(calls,130)
  }finally{console.log=original}
})
