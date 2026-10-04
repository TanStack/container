import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {decodeCases} from './fixtures/native-utf8-decode-cases.mjs'

test('decode corpus matches Node through existing fallback, including view offsets',()=>{
  const scope={decodeCodePointsArray:values=>String.fromCharCode(...values)}
  runInNewContext(readFileSync('src/compiler/buffer-utf8-slice.js','utf8'),scope)
  for(const bytes of decodeCases()){
    const backing=Uint8Array.from([65,66,...bytes,67,68]),view=backing.subarray(2,2+bytes.length)
    for(const [start,end] of [[0,view.length],[Math.min(1,view.length),view.length],[0,Math.max(0,view.length-1)]]){
      assert.equal(scope.utf8Slice(view,start,end),Buffer.from(view.buffer,view.byteOffset,view.length).toString('utf8',start,end))
    }
  }
})
