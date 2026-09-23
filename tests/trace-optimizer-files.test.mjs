import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,webcrypto} from 'node:crypto'
import {traceOptimizerFiles} from './sdk/helpers/trace-optimizer-files.mjs'

if(!globalThis.crypto)globalThis.crypto=webcrypto

const bytes=value=>new TextEncoder().encode(value)
const hash=value=>createHash('sha256').update(value).digest('hex')

function fixture({entries,stats,files={},readdirError,statError,closeError}={}){
  const calls=[],state={closed:0}
  const session={
    async call(method,args){
      calls.push([method,args])
      if(method==='readdir'){
        if(readdirError)throw readdirError
        return entries
      }
      if(method==='lstat'){
        if(statError?.[args[0]])throw statError[args[0]]
        return stats[args[0]]
      }
      throw Error('Unexpected method: '+method)
    },
    async close(){state.closed++;if(closeError)throw closeError},
  }
  return {
    state,calls,
    kernel:{
      async openFileSession(options){calls.push(['open',options]);return session},
      async readFile(path){calls.push(['readFile',[path]]);const value=files[path];if(value instanceof Error)throw value;return value},
    },
  }
}

test('captures committed and temporary optimizer files through a read-only lease',async()=>{
  const root='/project/node_modules/.vite',metadata=bytes('{"optimized":{}}'),output=bytes('export default 1')
  const f=fixture({
    entries:[
      {relativePath:'deps_temp_deadbeef/react.js',kind:'file'},
      {relativePath:'deps',kind:'directory'},
      {relativePath:'deps/_metadata.json',kind:'file'},
    ],
    stats:{
      [root+'/deps']:{kind:'directory',size:0,mode:0o40755,mtimeMs:1},
      [root+'/deps/_metadata.json']:{kind:'file',size:metadata.length,mode:0o100644,mtimeMs:2},
      [root+'/deps_temp_deadbeef/react.js']:{kind:'file',size:output.length,mode:0o100644,mtimeMs:3},
    },
    files:{[root+'/deps/_metadata.json']:metadata,[root+'/deps_temp_deadbeef/react.js']:output},
  })
  const result=await traceOptimizerFiles(f.kernel)
  assert.equal(result.present,true)
  assert.equal(result.truncated,false)
  assert.deepEqual(result.errors,[])
  assert.deepEqual(result.entries.map(entry=>entry.path),[
    root+'/deps',root+'/deps/_metadata.json',root+'/deps_temp_deadbeef/react.js',
  ])
  assert.equal(result.entries[1].sha256,hash(metadata))
  assert.equal(result.entries[2].sha256,hash(output))
  assert.deepEqual(f.calls[0],['open',{writable:false}])
  assert.equal(f.state.closed,1)
})

test('bounds entries and hashing while preserving explicit evidence',async()=>{
  const root='/project/node_modules/.vite',small=bytes('small'),large=bytes('too large')
  const f=fixture({
    entries:[{relativePath:'b.js',kind:'file'},{relativePath:'a.js',kind:'file'},{relativePath:'c.js',kind:'file'}],
    stats:{
      [root+'/a.js']:{kind:'file',size:small.length,mode:0o100644,mtimeMs:1},
      [root+'/b.js']:{kind:'file',size:large.length,mode:0o100644,mtimeMs:2},
    },
    files:{[root+'/a.js']:small,[root+'/b.js']:large},
  })
  const result=await traceOptimizerFiles(f.kernel,{maxEntries:2,maxHashFileBytes:5,maxHashBytes:5})
  assert.equal(result.truncated,true)
  assert.equal(result.entries[0].sha256,hash(small))
  assert.equal(result.entries[1].hashSkipped,'file-limit')
  assert.equal(f.calls.filter(([method])=>method==='readFile').length,1)
  assert.equal(f.state.closed,1)
})

test('reports directory and entry failures and always closes its lease',async()=>{
  const missing=Object.assign(Error('ENOENT: missing optimizer directory'),{code:'ENOENT'})
  const absent=fixture({readdirError:missing})
  const result=await traceOptimizerFiles(absent.kernel)
  assert.equal(result.present,false)
  assert.deepEqual(result.errors.map(error=>[error.operation,error.code]),[['readdir','ENOENT']])
  assert.equal(absent.state.closed,1)

  const root='/project/node_modules/.vite',broken=fixture({
    entries:[{relativePath:'deps/broken.js',kind:'file'}],stats:{},
    statError:{[root+'/deps/broken.js']:Error('stat failed')},closeError:Error('close failed'),
  })
  const partial=await traceOptimizerFiles(broken.kernel)
  assert.deepEqual(partial.errors.map(error=>error.operation),['lstat','close'])
  assert.equal(broken.state.closed,1)
})
