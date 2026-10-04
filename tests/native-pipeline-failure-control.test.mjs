import {test} from 'node:test'
import assert from 'node:assert/strict'
import {Writable} from 'node:stream'
import {pipeline} from 'node:stream/promises'

for(const useError of [true,false])test(`Node pipeline rejects a waiting source on destination ${useError?'error':'close'}`,{timeout:2000},async()=>{
  const destination=new Writable({write(chunk,encoding,done){done()}})
  let cancelled=false
  const source=new ReadableStream({cancel(){cancelled=true}})
  const running=pipeline(source,destination)
  destination.destroy(useError?Error('pipeline probe failure'):undefined)
  await assert.rejects(running,useError?/pipeline probe failure/:{code:'ERR_STREAM_PREMATURE_CLOSE'})
  assert.equal(cancelled,true)
})
