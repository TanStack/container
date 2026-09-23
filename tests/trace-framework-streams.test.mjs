import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {guestStreamTracePrelude,traceFrameworkStreams} from './sdk/helpers/trace-framework-streams.mjs'

function fixture(log){
  const rows=[],calls=[],result={}
  class ReadStream extends EventEmitter{
    constructor(path='/project/node_modules/.vite/deps/react.js'){
      super();this.path=path;this.bytesRead=5;this.readableLength=3;this.readableFlowing=null
      this._readableState={length:3,reading:false,constructed:false,buffer:'secret file content'}
    }
    _construct(...args){calls.push({method:'construct',receiver:this,args});return result}
    _read(...args){calls.push({method:'read',receiver:this,args});return result}
  }
  traceFrameworkStreams({ReadStream},log??(line=>rows.push(JSON.parse(line.slice('FRAMEWORK_STREAM_TRACE '.length)))))
  return {ReadStream,rows,calls,result}
}

test('forwards methods and callback receiver, arguments and return identities',()=>{
  const f=fixture(),stream=new f.ReadStream(),context={},arg={},extra={}
  let callbackCall
  const callback=function(...args){callbackCall={receiver:this,args};return f.result}
  assert.equal(stream._construct(callback,extra),f.result)
  assert.equal(f.calls[0].receiver,stream)
  assert.equal(f.calls[0].args[1],extra)
  assert.equal(f.calls[0].args[0].call(context,arg,extra),f.result)
  assert.equal(callbackCall.receiver,context)
  assert.deepEqual(callbackCall.args,[arg,extra])
  assert.equal(stream._read(arg,extra),f.result)
  assert.equal(f.calls[1].receiver,stream)
  assert.deepEqual(f.calls[1].args,[arg,extra])
  assert.deepEqual(f.rows.map(row=>row.phase),['construct-enter','construct-callback','read-enter'])
  assert.equal(f.rows[0].readableFlowing,null)
  assert.deepEqual(f.rows[0].readableState,{length:3,reading:false,constructed:false})
  assert.equal(JSON.stringify(f.rows).includes('secret'),false)
})

test('event wrapper is passive and preserves listener arguments and unhandled errors',()=>{
  const f=fixture(),stream=new f.ReadStream(),arg={},error=new Error('secret')
  assert.deepEqual(stream.eventNames(),[])
  assert.equal(stream.emit('readable'),false)
  assert.equal(stream.readableFlowing,null)
  let receiver,received
  stream.on('open',function(...args){receiver=this;received=args})
  assert.equal(stream.emit('open',arg,1),true)
  assert.equal(receiver,stream)
  assert.deepEqual(received,[arg,1])
  for(const event of ['ready','end','close'])assert.equal(stream.emit(event),false)
  assert.throws(()=>stream.emit('error',error),value=>value===error)
  stream.emit('data','secret file content')
  assert.deepEqual(f.rows.map(row=>row.phase),['emit-readable','emit-open','emit-ready','emit-end','emit-close','emit-error'])
  assert.equal(JSON.stringify(f.rows).includes('secret'),false)
  assert.equal(stream.listenerCount('readable'),0)
})

test('excludes unrelated paths and caps streams and observations',()=>{
  const f=fixture(),callback=()=>{}
  new f.ReadStream('/project/src/app.js')._construct(callback)
  assert.equal(f.calls[0].args[0],callback)
  assert.equal(f.rows.length,0)
  for(let index=0;index<20;index++)new f.ReadStream()._read(1)
  assert.equal(f.rows.length,16)
  const first=f.calls[1].receiver
  for(let index=0;index<200;index++)first._read(1)
  assert.equal(f.rows.length,128)
  assert.equal(f.rows.at(-1).sequence,128)
})

test('diagnostic failures do not change original exceptions or callback exceptions',()=>{
  const f=fixture(()=>{throw new Error('logging failed')}),stream=new f.ReadStream(),error=new Error('callback failed')
  assert.equal(stream._read(1),f.result)
  stream._construct(()=>{throw error})
  assert.throws(()=>f.calls.at(-1).args[0](),value=>value===error)
  const originalError=new Error('read failed')
  class ReadStream{_read(){throw originalError}}
  traceFrameworkStreams({ReadStream},()=>{})
  assert.throws(()=>new ReadStream()._read(),value=>value===originalError)
})

test('prelude is self contained and uses the guest node filesystem',()=>{
  assert.match(guestStreamTracePrelude,/import \* as __frameworkStreamTraceFs from 'node:fs'/)
  const fs={ReadStream:class{_read(){return 42}}}
  new Function('__frameworkStreamTraceFs','console',guestStreamTracePrelude.replace(/^import[^\n]+\n/,''))(fs,{log(){}})
  assert.equal(new fs.ReadStream()._read(),42)
})
