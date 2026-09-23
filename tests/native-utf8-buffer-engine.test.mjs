import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {build} from 'esbuild'
import {guestBufferPlugin} from '../scripts/guest-buffer-plugin.mjs'

const root=process.env.NATIVE_UTF8_BUFFER_ENGINE&&resolve(process.env.NATIVE_UTF8_BUFFER_ENGINE)
let engine
async function runtime(){
  if(!engine){
    const core=await import(pathToFileURL(join(root,'core.mjs')).href)
    const {default:factory}=await import(pathToFileURL(join(root,'engine.mjs')).href)
    const {QuickJSAsyncFFI}=await import(pathToFileURL(join(root,'ffi.mjs')).href)
    engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>QuickJSAsyncFFI,importModuleLoader:async()=>async()=>factory({wasmBinary:readFileSync(join(root,'engine.wasm'))})})
  }
  const rt=engine.newRuntime();rt.setMemoryLimit(16*1024*1024)
  return rt
}
function evaluate(ctx,source){
  const result=ctx.evalCode(source)
  if(result.error){const error=ctx.dump(result.error);result.dispose();throw Error(JSON.stringify(error))}
  try{return ctx.dump(result.value)}finally{result.value.dispose()}
}

test('actual WASM UTF8 counting and bounded writes match Node',{skip:!root},async()=>{
  const rt=await runtime(),ctx=rt.newContext()
  try{
    const texts=['','ASCII\0end','é水😀','\ud800','\udc00','\ud800\ud800x','x\udc00\ud800','\udbff\udfff']
    let seed=83
    for(let i=0;i<200;i++){
      let text=''
      for(let j=0;j<20;j++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;text+=String.fromCharCode(seed&65535)}
      texts.push(text)
    }
    for(const text of texts){
      const expectedLength=Buffer.byteLength(text)
      assert.equal(evaluate(ctx,`__qjsUTF8ByteLength(${JSON.stringify(text)})`),expectedLength)
      for(const limit of [0,1,2,3,4,7,64]){
        const expected=Buffer.alloc(80,0xa5),view=expected.subarray(5,75)
        const count=view.write(text,3,limit,'utf8')
        const actual=evaluate(ctx,`(()=>{const backing=new Uint8Array(80).fill(165);const view=backing.subarray(5,75);const count=__qjsWriteUTF8(${JSON.stringify(text)},view,3,${limit});return {count,bytes:Array.from(backing)}})()`)
        assert.deepEqual(actual,{count,bytes:[...expected]})
      }
    }
  }finally{ctx.dispose();rt.dispose()}
})

test('actual WASM UTF8 handles guest ropes and strict private argument validation',{skip:!root},async()=>{
  const rt=await runtime(),ctx=rt.newContext()
  try{
    const parts=['x'.repeat(512)+'\ud83d','\ude00'+'水'.repeat(512)]
    const expected=Buffer.from(parts.join(''))
    const actual=evaluate(ctx,`(()=>{let text='';for(const part of ${JSON.stringify(parts)})text+=part;const count=__qjsUTF8ByteLength(text);const bytes=new Uint8Array(count);const written=__qjsWriteUTF8(text,bytes,0,count);return {count,written,bytes:Array.from(bytes)}})()`)
    assert.deepEqual(actual,{count:expected.length,written:expected.length,bytes:[...expected]})
    for(const source of [
      '__qjsUTF8ByteLength(42)',
      '__qjsWriteUTF8("x",new Uint16Array(4),0,1)',
      '__qjsWriteUTF8("x",new Uint8Array(4),-1,1)',
      '__qjsWriteUTF8("x",new Uint8Array(4),0,5)',
      '__qjsWriteUTF8("x",new Uint8Array(4),0.5,1)',
      '__qjsWriteUTF8("x",new Uint8Array(4),0,Infinity)',
    ]){
      const result=ctx.evalCode(source)
      try{assert.ok(result.error,source)}finally{result.dispose()}
    }
    assert.equal(evaluate(ctx,'__qjsUTF8ByteLength("ok")'),2)
  }finally{ctx.dispose();rt.dispose()}
})

test('actual WASM UTF8 byte counting and writes retain cancellation and recovery',{skip:!root},async()=>{
  const rt=await runtime(),ctx=rt.newContext()
  try{
    evaluate(ctx,'globalThis.input="x".repeat(1024*1024);globalThis.bytes=new Uint8Array(input.length);0')
    for(const source of ['__qjsUTF8ByteLength(input)','__qjsWriteUTF8(input,bytes,0,bytes.length)']){
      let polls=0;rt.setInterruptHandler(()=>++polls>=3)
      const result=ctx.evalCode(source)
      try{assert.ok(result.error);assert.match(JSON.stringify(ctx.dump(result.error)),/interrupted/);assert.ok(polls>=3)}finally{result.dispose();rt.removeInterruptHandler()}
      assert.equal(evaluate(ctx,'__qjsUTF8ByteLength("é")'),2)
    }
  }finally{ctx.dispose();rt.dispose()}
})

test('bundled guest Buffer uses native counting and writes with Node boundary behavior',{skip:!root},async()=>{
  const bundle=await build({stdin:{contents:'module.exports=require("buffer/").Buffer',resolveDir:process.cwd()},bundle:true,write:false,format:'cjs',platform:'browser',plugins:[guestBufferPlugin()]})
  const rt=await runtime(),ctx=rt.newContext()
  try{
    evaluate(ctx,`globalThis.__webContainerHost={encodeUTF8:__qjsEncodeUTF8,utf8ByteLength:__qjsUTF8ByteLength,writeUTF8:__qjsWriteUTF8};globalThis.module={exports:{}};${bundle.outputFiles[0].text};globalThis.Buffer=module.exports;0`)
    for(const text of ['', '\u007f','\u0080','\u07ff','\u0800','\ud800\udc00','é水😀']){
      for(const length of [0,1,2,3,4,12]){
        const bytes=Buffer.alloc(16,0xa5),view=bytes.subarray(2,14)
        const written=view.write(text,0,length,'utf8')
        const actual=evaluate(ctx,`(()=>{const bytes=Buffer.alloc(16,165),view=bytes.subarray(2,14);return {written:view.write(${JSON.stringify(text)},0,${length},'utf8'),length:Buffer.byteLength(${JSON.stringify(text)}),bytes:Array.from(bytes)}})()`)
        assert.deepEqual(actual,{written,length:Buffer.byteLength(text),bytes:[...bytes]})
      }
    }
    assert.deepEqual(evaluate(ctx,'[Buffer.alloc(0).write("x",0,0),Buffer.alloc(4).write("x",4,0)]'),[0,0])
  }finally{ctx.dispose();rt.dispose()}
})
