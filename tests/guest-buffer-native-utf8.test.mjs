import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {runInNewContext} from 'node:vm'
import {readFileSync} from 'node:fs'
import {guestBufferPlugin} from '../scripts/guest-buffer-plugin.mjs'

const result=await build({stdin:{contents:'module.exports=require("buffer/").Buffer',resolveDir:process.cwd()},bundle:true,write:false,format:'cjs',platform:'browser',plugins:[guestBufferPlugin()]})
function implementation(native){
  const context={module:{exports:{}},__webContainerHost:typeof native==='function'?{encodeUTF8:native}:native}
  runInNewContext(result.outputFiles[0].text,context)
  return context.module.exports
}

test('native UTF8 dispatch preserves Buffer values, ownership and other encodings',()=>{
  let calls=0,last
  const GuestBuffer=implementation(text=>{calls++;last=new TextEncoder().encode(text).buffer;return last})
  const values=['','abc\0def','é水😀','\ud800','\udc00','\ud800\ud800x','x\udc00\ud800','\udbff\udfff']
  let seed=17
  for(let i=0;i<200;i++){let value='';for(let j=0;j<24;j++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;value+=String.fromCharCode(seed&65535)}values.push(value)}
  for(const value of values)for(const encoding of [undefined,'utf8','UTF8','utf-8','UTF-8','']){
    const before=calls,actual=GuestBuffer.from(value,encoding)
    assert.equal(calls,before+1)
    assert.deepEqual([...actual],[...Buffer.from(value,encoding)])
    assert.equal(GuestBuffer.isBuffer(actual),true)
    assert.equal(Object.getPrototypeOf(actual),GuestBuffer.prototype)
    assert.equal(actual.buffer,last)
    assert.equal(actual.byteOffset,0)
    const next=GuestBuffer.from(value,encoding);assert.notEqual(next.buffer,actual.buffer)
  }
  const before=calls
  for(const encoding of ['hex','base64','latin1','ascii','utf16le'])assert.deepEqual([...GuestBuffer.from('616263',encoding)],[...Buffer.from('616263',encoding)])
  assert.equal(calls,before)
  assert.throws(()=>GuestBuffer.from('x','invalid'),/Unknown encoding/)
})

test('profiles without the native codec retain the existing UTF8 implementation',()=>{
  const GuestBuffer=implementation()
  for(const text of ['hello','é水😀','\ud800','\udc00'])assert.deepEqual([...GuestBuffer.from(text)],[...Buffer.from(text)])
})

test('native counts and bounded writes match Node without calling the allocating encoder',()=>{
  let counts=0,writes=0
  const GuestBuffer=implementation({
    encodeUTF8(){throw Error('Unexpected encoded copy')},
    utf8ByteLength(text){counts++;return Buffer.byteLength(text)},
    writeUTF8(text,destination,offset,limit){
      writes++
      assert.ok(Number.isInteger(limit)&&limit>=0&&limit<=destination.length-offset)
      return Buffer.from(destination.buffer,destination.byteOffset,destination.byteLength).write(text,offset,limit,'utf8')
    },
  })
  const values=['','abc\0def','é水😀','\ud800','\udc00','\ud800\ud800x','x\udc00\ud800','\udbff\udfff']
  let seed=31
  for(let i=0;i<100;i++){let text='';for(let j=0;j<16;j++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;text+=String.fromCharCode(seed&65535)}values.push(text)}
  for(const text of values){
    for(const encoding of [undefined,'utf8','UTF8','utf-8','UTF-8'])assert.equal(GuestBuffer.byteLength(text,encoding),Buffer.byteLength(text,encoding))
    for(let limit=0;limit<=32;limit++){
      // Nonzero underlying byteOffset verifies native receives the view itself.
      const backing=GuestBuffer.alloc(48,0xAB),actual=backing.subarray(4,44),expected=Buffer.alloc(40,0xAB)
      assert.equal(actual.write(text,3,limit,'utf8'),expected.write(text,3,limit,'utf8'))
      assert.deepEqual([...actual],[...expected])
      assert.deepEqual([...backing.subarray(0,4)],[0xAB,0xAB,0xAB,0xAB])
      assert.deepEqual([...backing.subarray(44)],[0xAB,0xAB,0xAB,0xAB])
    }
    const actual=GuestBuffer.alloc(8),expected=Buffer.alloc(8)
    assert.equal(actual.write(text,2,100),expected.write(text,2,6))
    assert.deepEqual([...actual],[...expected])
  }
  assert.ok(counts>0);assert.ok(writes>0)
})

test('Buffer validation and non-UTF8 dispatch happen before optional native operations',()=>{
  let calls=0
  const GuestBuffer=implementation({utf8ByteLength(){calls++;throw Error('native')},writeUTF8(){calls++;throw Error('native')}})
  const buffer=GuestBuffer.alloc(4)
  for(const offset of [-1,5])assert.throws(()=>buffer.write('x',offset),/bounds/)
  assert.throws(()=>buffer.write('x',0,1,'unknown'),/Unknown encoding/)
  assert.throws(()=>GuestBuffer.byteLength({}),/string/)
  for(const encoding of ['hex','base64','latin1','ascii','utf16le']){
    assert.equal(GuestBuffer.byteLength('6162',encoding),Buffer.byteLength('6162',encoding))
    const expected=Buffer.alloc(4)
    assert.equal(buffer.write('6162',0,4,encoding),expected.write('6162',0,4,encoding))
  }
  assert.equal(calls,0)
})

test('native count and write capabilities are independently optional',()=>{
  const countOnly=implementation({utf8ByteLength:text=>Buffer.byteLength(text)})
  const writeOnly=implementation({writeUTF8:(text,destination,offset,limit)=>Buffer.from(destination.buffer,destination.byteOffset,destination.byteLength).write(text,offset,limit)})
  for(const GuestBuffer of [countOnly,writeOnly,implementation({utf8ByteLength:0,writeUTF8:null})]){
    assert.equal(GuestBuffer.byteLength('é水😀'),9)
    const actual=GuestBuffer.alloc(8),expected=Buffer.alloc(8)
    assert.equal(actual.write('é水😀',0,8),expected.write('é水😀',0,8))
    assert.deepEqual([...actual],[...expected])
  }
})

test('kernel captures optional UTF8 capabilities and removes their private globals',()=>{
  const worker=readFileSync('src/sandbox/kernel.worker.ts','utf8')
  const start=worker.indexOf("      if(typeof globalThis.__qjsEncodeUTF8==='function')")
  const end=worker.indexOf('      globalThis.__webContainerHost.filesystemTask=',start)
  assert.ok(start>=0&&end>start)
  for(const enabled of [true,false]){
    const count=()=>3,write=()=>2
    const context={__webContainerHost:{},__qjsUTF8ByteLength:enabled?count:0,__qjsWriteUTF8:enabled?write:null}
    runInNewContext(worker.slice(start,end),context)
    assert.equal('__qjsUTF8ByteLength' in context,false)
    assert.equal('__qjsWriteUTF8' in context,false)
    assert.equal(context.__webContainerHost.utf8ByteLength,enabled?count:undefined)
    assert.equal(context.__webContainerHost.writeUTF8,enabled?write:undefined)
  }
})
