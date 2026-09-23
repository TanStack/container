import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {dirname} from 'node:path'
import {runInNewContext} from 'node:vm'
import {build} from 'esbuild'
import {stageTextEncoding} from '../scripts/stage-text-encoding.mjs'

const result=await build({stdin:{contents:'module.exports=require("@kayahr/text-encoding").TextEncoder',resolveDir:process.cwd()},bundle:true,write:false,format:'cjs',platform:'browser',plugins:[{name:'text-encoding-test',setup(builder){builder.onLoad({filter:/[/\\]TextEncoder\.js$/},args=>({contents:stageTextEncoding(readFileSync(args.path,'utf8'),'TextEncoder'),loader:'js',resolveDir:dirname(args.path)}))}}]})
function implementation(native){const context={module:{exports:{}},__webContainerHost:native?{encodeUTF8:native}:undefined};runInNewContext(result.outputFiles[0].text,context);return context.module.exports}

test('TextEncoder uses native UTF8 bytes and preserves a fresh byte view per call',()=>{
  let calls=0
  const Encoder=implementation(text=>{calls++;return new TextEncoder().encode(text).buffer}),encoder=new Encoder()
  for(const text of ['','ASCII\0','é水😀','\ud800','\udc00','x\ud800y']){
    const before=calls,actual=encoder.encode(text),next=encoder.encode(text)
    assert.equal(calls,before+2)
    assert.deepEqual([...actual],[...new TextEncoder().encode(text)])
    assert.notEqual(actual.buffer,next.buffer)
  }
  assert.throws(()=>Encoder.prototype.encode.call({},'x'))
})

test('TextEncoder retains its existing implementation without a native primitive',()=>{
  const encoder=new (implementation())()
  for(const text of ['','ASCII','é水😀','\ud800','\udc00'])assert.deepEqual([...encoder.encode(text)],[...new TextEncoder().encode(text)])
})
