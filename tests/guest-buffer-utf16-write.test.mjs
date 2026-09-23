import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {runInNewContext} from 'node:vm'
import {readFileSync} from 'node:fs'
import {guestBufferPlugin} from '../scripts/guest-buffer-plugin.mjs'

const built=await build({stdin:{contents:'module.exports=require("buffer/").Buffer',resolveDir:process.cwd()},bundle:true,write:false,format:'cjs',platform:'browser',plugins:[guestBufferPlugin()]})
const context={module:{exports:{}}}
runInNewContext(built.outputFiles[0].text,context)
const GuestBuffer=context.module.exports

test('direct UTF16 writes match Node for aliases, surrogates and bounded views',()=>{
  const values=['','abc\0def','é水😀','\ud800','\udc00','\ud800x\udc00','\udbff\udfff']
  let seed=13
  for(let i=0;i<80;i++){let text='';for(let j=0;j<20;j++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;text+=String.fromCharCode(seed&65535)}values.push(text)}
  for(const text of values)for(const encoding of ['utf16le','utf-16le','ucs2','ucs-2','UTF16LE','UCS-2']){
    assert.deepEqual([...GuestBuffer.from(text,encoding)],[...Buffer.from(text,encoding)])
    for(let size=0;size<=13;size++)for(let offset=0;offset<=size;offset++)for(let length=0;length<=size-offset;length++){
      const actualBacking=GuestBuffer.alloc(size+8,0xab),expectedBacking=Buffer.alloc(size+8,0xab)
      const actual=actualBacking.subarray(3,3+size),expected=expectedBacking.subarray(3,3+size)
      assert.equal(actual.write(text,offset,length,encoding),expected.write(text,offset,length,encoding))
      assert.deepEqual([...actualBacking],[...expectedBacking])
    }
  }
})

test('direct helper needs no temporary encoder or blit function',()=>{
  const scope={}
  runInNewContext(readFileSync('src/compiler/buffer-utf16-write.js','utf8'),scope)
  const output=new Uint8Array(5).fill(0xab)
  assert.equal(scope.ucs2Write(output,'AB',0,3),2)
  assert.deepEqual([...output],[65,0,0xab,0xab,0xab])
})

test('write validation and other encodings retain existing dispatch',()=>{
  for(const encoding of ['utf8','ascii','latin1','hex','base64']){
    const actual=GuestBuffer.alloc(12,0xab),expected=Buffer.alloc(12,0xab)
    assert.equal(actual.write('616263',2,6,encoding),expected.write('616263',2,6,encoding))
    assert.deepEqual([...actual],[...expected])
  }
  for(const offset of [-1,9])assert.throws(()=>GuestBuffer.alloc(8).write('x',offset,1,'utf16le'))
  assert.throws(()=>GuestBuffer.alloc(8).write('x',0,1,'unsupported'))
})
