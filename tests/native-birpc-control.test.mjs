import {test} from 'node:test'
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
test('Node completes the forked bundled RPC exchange',{timeout:5000},async()=>{
  const {stdout,stderr}=await promisify(execFile)(process.execPath,[new URL('./fixtures/native-birpc-parent.mjs',import.meta.url).pathname],{timeout:4000})
  assert.equal(stdout,'rpc answer:5\nrpc exit:0\n')
  assert.equal(stderr,'')
})
