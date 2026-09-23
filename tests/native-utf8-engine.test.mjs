import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {build} from 'esbuild'
import {guestBufferPlugin} from '../scripts/guest-buffer-plugin.mjs'

const root=process.env.NATIVE_UTF8_ENGINE&&resolve(process.env.NATIVE_UTF8_ENGINE)
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
function unwrap(context,result){if(result.error){const error=context.dump(result.error);result.dispose();throw Error(JSON.stringify(error))}return result.value}

test('native encoder handles guest concatenation ropes, including split surrogate pairs',{skip:!root},async()=>{
  const rt=await runtime(),context=rt.newContext()
  try{
    for(const parts of [Array.from({length:100},(_,i)=>`<script>item${i}</script>`),['x'.repeat(512)+'\ud83d','\ude00'+'水'.repeat(512)]]){
      // Build in the guest. Passing a host string or calling charCodeAt first
      // can flatten a rope and hide this representation boundary.
      const handle=unwrap(context,context.evalCode(`(()=>{const parts=${JSON.stringify(parts)};let text='';for(const part of parts)text+=part;return __qjsEncodeUTF8(text)})()`))
      try{const bytes=context.getArrayBuffer(handle);try{assert.deepEqual(Buffer.from(bytes.value),Buffer.from(parts.join('')))}finally{bytes.dispose()}}finally{handle.dispose()}
    }
  }finally{context.dispose();rt.dispose()}
})

test('native engine encodes actual guest UTF16, including unmatched surrogates',{skip:!root},async()=>{
  const rt=await runtime(),context=rt.newContext()
  try{
    const texts=['','ASCII\0end','é水😀','\ud800','\udc00','\ud800\ud800x','x\udc00\ud800','\udbff\udfff']
    let seed=19
    for(let i=0;i<500;i++){let text='';for(let j=0;j<24;j++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;text+=String.fromCharCode(seed&65535)}texts.push(text)}
    for(const text of texts){
      // Escaped source preserves unmatched surrogate code units inside QuickJS.
      // context.newString would encode through the host and could mask this bug.
      const handle=unwrap(context,context.evalCode(`__qjsEncodeUTF8(${JSON.stringify(text)})`))
      try{const bytes=context.getArrayBuffer(handle);try{assert.deepEqual([...bytes.value],[...Buffer.from(text)])}finally{bytes.dispose()}}finally{handle.dispose()}
    }
    const ownership=unwrap(context,context.evalCode(`(()=>{const a=__qjsEncodeUTF8('abc'),b=__qjsEncodeUTF8('abc');new Uint8Array(a)[0]=0;return [a!==b,new Uint8Array(b)[0],Object.prototype.toString.call(a)]})()`))
    try{assert.deepEqual(context.dump(ownership),[true,97,'[object ArrayBuffer]'])}finally{ownership.dispose()}
    const invalid=context.evalCode('__qjsEncodeUTF8(42)');try{assert.ok(invalid.error)}finally{invalid.dispose()}
  }finally{context.dispose();rt.dispose()}
})

test('native engine releases repeated large encodings under a fixed guest heap',{skip:!root},async()=>{
  const rt=await runtime(),context=rt.newContext()
  try{
    unwrap(context,context.evalCode("globalThis.input='x'.repeat(1024*1024)")).dispose()
    for(let i=0;i<32;i++){
      const handle=unwrap(context,context.evalCode('__qjsEncodeUTF8(input)'))
      try{const bytes=context.getArrayBuffer(handle);try{assert.equal(bytes.value.length,1024*1024);assert.equal(bytes.value[0],120);assert.equal(bytes.value.at(-1),120)}finally{bytes.dispose()}}finally{handle.dispose()}
    }
  }finally{context.dispose();rt.dispose()}
})

test('native UTF8 polling respects interruption and leaves the runtime usable',{skip:!root},async()=>{
  const rt=await runtime(),context=rt.newContext()
  try{
    unwrap(context,context.evalCode("globalThis.input='x'.repeat(1024*1024)")).dispose()
    let polls=0;rt.setInterruptHandler(()=>++polls>=3)
    const interrupted=context.evalCode('__qjsEncodeUTF8(input)')
    try{assert.ok(interrupted.error);assert.match(JSON.stringify(context.dump(interrupted.error)),/interrupted/);assert.ok(polls>=3)}finally{interrupted.dispose()}
    rt.removeInterruptHandler()
    const recovered=unwrap(context,context.evalCode('__qjsEncodeUTF8("ok").byteLength'))
    try{assert.equal(context.dump(recovered),2)}finally{recovered.dispose()}
  }finally{context.dispose();rt.dispose()}
})

test('native bytes survive Buffer construction, concat and later allocations',{skip:!root},async()=>{
  const bundle=await build({stdin:{contents:'module.exports=require("buffer/").Buffer',resolveDir:process.cwd()},bundle:true,write:false,format:'cjs',platform:'browser',plugins:[guestBufferPlugin()]})
  const rt=await runtime(),context=rt.newContext()
  try{
    unwrap(context,context.evalCode(`globalThis.__webContainerHost={encodeUTF8:__qjsEncodeUTF8};globalThis.module={exports:{}};${bundle.outputFiles[0].text};globalThis.Buffer=module.exports;`)).dispose()
    const result=unwrap(context,context.evalCode(`(()=>{
      const text='export const message = "é水😀";\\n'.repeat(32);
      const retained=Array.from({length:100},()=>Buffer.from(text));
      for(let i=0;i<100;i++)Buffer.from('allocation '+i+' x'.repeat(1000));
      return retained.every(bytes=>Buffer.isBuffer(bytes)&&bytes.toString()===text&&Buffer.concat([Buffer.from('prefix'),bytes,Buffer.from('suffix')]).toString()==='prefix'+text+'suffix');
    })()`))
    try{assert.equal(context.dump(result),true)}finally{result.dispose()}
  }finally{context.dispose();rt.dispose()}
})

test('native encoded views survive fiber parks and allocation pressure',{skip:!root},async()=>{
  const rt=await runtime(),context=rt.newContext()
  try{
    const initializer=unwrap(context,context.evalCode('park=>{globalThis.park=park}'))
    try{unwrap(context,context.initializeFiber(initializer)).dispose()}finally{initializer.dispose()}
    const fn=unwrap(context,context.evalCode(`()=>{
      const text='(self.$R=self.$R||{}); é水😀'.repeat(64);
      const bytes=new Uint8Array(__qjsEncodeUTF8(text));
      const expected=Array.from(bytes);
      for(let round=0;round<8;round++){
        park();
        for(let i=0;i<80;i++){
          const cycle={bytes:new Uint8Array(__qjsEncodeUTF8('pressure'.repeat(1024)))};
          cycle.self=cycle;
        }
        if(bytes.length!==expected.length||!bytes.every((n,i)=>n===expected[i]))return false;
      }
      return true;
    }`))
    const task=context.startFiberCall(fn)
    try{
      for(let i=0;i<8;i++){assert.equal(task.step(),1);assert.equal(task.deliver(0),true)}
      assert.equal(task.step(),2)
      const result=unwrap(context,task.takeResult())
      try{assert.equal(context.dump(result),true)}finally{result.dispose()}
    }finally{if(task.status()!==2){task.cancel();task.step();task.takeResult().dispose()}task.dispose();fn.dispose()}
  }finally{context.dispose();rt.dispose()}
})
