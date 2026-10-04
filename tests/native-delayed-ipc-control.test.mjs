import {test} from 'node:test'
import assert from 'node:assert/strict'
import {fork} from 'node:child_process'

test('Node delivers a message sent before a fork installs its listener',{timeout:2000},async()=>{
  const child=fork(new URL('./fixtures/native-delayed-ipc-child.mjs',import.meta.url),[],{stdio:'pipe'})
  const messages=[]
  let stderr=''
  child.stderr.on('data',bytes=>{stderr+=bytes})
  const exit=new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject)})
  child.on('message',value=>messages.push(value))
  try{
    child.send(42)
    assert.equal(await exit,0,stderr)
    assert.deepEqual(messages,[{listening:true},{received:42}])
  }finally{child.kill()}
})
