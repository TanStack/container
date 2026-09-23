import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'

const source=readFileSync(new URL('../src/sandbox/kernel.worker.ts',import.meta.url),'utf8')

function exactlyOnce(value,message){
  assert.equal(source.split(value).length,2,message)
}

test('guest socket writes cross the QuickJS boundary as owned binary bytes',()=>{
  exactlyOnce("expose('__netWrite',(handle,value)=>{",'expected one host socket write boundary')
  const start=source.indexOf("expose('__netWrite',(handle,value)=>{")
  const end=source.indexOf("    })",start)
  assert.notEqual(start,-1)
  assert.notEqual(end,-1)
  const boundary=source.slice(start,end)
  assert.match(boundary,/context\.getArrayBuffer\(value\)/)
  assert.match(boundary,/borrowed\.value\.byteLength>65536/)
  assert.match(boundary,/data=borrowed\.value\.slice\(\)/)
  assert.match(boundary,/finally\{borrowed\.dispose\(\)\}/)
  assert.match(boundary,/networkPromise\(\(\)=>network\.write\(id,key,data\),data\.length\)/)
  assert.doesNotMatch(boundary,/JSON\.parse|Array\.from|context\.getString/)
})

test('guest adapter validates Uint8Array and transfers only its visible range',()=>{
  exactlyOnce("write:(key,bytes)=>{\n        if(!(bytes instanceof Uint8Array))throw new TypeError('Expected socket bytes');",'expected one guest socket adapter')
  assert.match(source,/return netWrite\(key,bytes\.buffer\.slice\(bytes\.byteOffset,bytes\.byteOffset\+bytes\.byteLength\)\);/)
  assert.doesNotMatch(source,/netWrite\(key,JSON\.stringify\(Array\.from\(bytes\)\)\)/)
})
