import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,writeFileSync,cpSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import {stageNativeUTF8} from '../scripts/stage-native-utf8.mjs'
import {stageNativeUTF8Buffer} from '../scripts/stage-native-utf8-buffer.mjs'

const upstream=resolve('.toolchains/quickjs-emscripten/vendor/quickjs')
const original=readFileSync(join(upstream,'quickjs.c'),'utf8')
function fixture(source=original){const path=join(mkdtempSync(join(tmpdir(),'utf8-buffer-stage-')),'quickjs.c');writeFileSync(path,source);return path}
test('Buffer stage requires the existing encoder and installs only two private capabilities',()=>{
  const path=fixture(),before=readFileSync(path)
  assert.throws(()=>stageNativeUTF8Buffer(path),/requires native UTF-8/);assert.deepEqual(readFileSync(path),before)
  stageNativeUTF8(path);const encoder=readFileSync(path,'utf8').split('static int qjs_utf8_next_code_point(')[1]
  stageNativeUTF8Buffer(path);const source=readFileSync(path,'utf8')
  assert.ok(source.includes('static int qjs_utf8_next_code_point('+encoder))
  for(const name of ['__qjsUTF8ByteLength','__qjsWriteUTF8'])assert.equal(source.split('"'+name+'"').length-1,2)
  assert.match(source,/JS_GetTypedArrayBuffer\(ctx, argv\[1\], &view_offset, NULL, NULL\)/)
  assert.match(source,/JS_GetArrayBuffer\(ctx, &backing_length, backing\)/)
  const staged=readFileSync(path);assert.throws(()=>stageNativeUTF8Buffer(path),/already installed/);assert.deepEqual(readFileSync(path),staged)
})
test('Buffer stage fails closed on drift',()=>{
  for(const marker of ['int JS_AddIntrinsicBaseObjects(JSContext *ctx)','const char *hidden[] = {']){
    const path=fixture();stageNativeUTF8(path);writeFileSync(path,readFileSync(path,'utf8').replace(marker,marker.replace(' ',' /*changed*/ ')))
    const before=readFileSync(path);assert.throws(()=>stageNativeUTF8Buffer(path),/Unexpected/);assert.deepEqual(readFileSync(path),before)
  }
})
test('Buffer build flag is explicit, dependent and distinct from encoding-only profiles',()=>{
  const source=readFileSync('scripts/build-quickjs-als.mjs','utf8')
  for(const text of ["process.argv.includes('--native-utf8-buffer')","if(nativeUTF8Buffer&&!nativeUTF8)","+(nativeUTF8Buffer?'-buffer':'')","...(nativeUTF8Buffer?{nativeUTF8Buffer:{experimental:true",'encodedOutputAllocation:false'])assert.ok(source.includes(text),text)
})

test('native count/write match Node across UTF16, ropes, sliced views, and limits',()=>{
  const directory=mkdtempSync(join(tmpdir(),'utf8-buffer-native-')),qjs=join(directory,'quickjs')
  cpSync(upstream,qjs,{recursive:true});stageNativeUTF8(join(qjs,'quickjs.c'));stageNativeUTF8Buffer(join(qjs,'quickjs.c'))
  const texts=['','a','abc','é水😀','\ud800','\udc00','a\ud800b','\ud800\ud800','\udbff\udfff','\0abc']
  let seed=23
  for(let i=0;i<40;i++){let text='';for(let j=0;j<18;j++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;text+=String.fromCharCode(seed&65535)}texts.push(text)}
  const cases=[]
  for(const text of texts)for(const offset of [0,3,9])for(let limit=0;limit<=9-offset;limit++){
    const backing=Buffer.alloc(15,165),view=backing.subarray(2,11),written=view.write(text,offset,limit,'utf8')
    cases.push({text,offset,limit,written,bytes:[...backing],length:Buffer.byteLength(text)})
  }
  const ropes=[Array.from({length:30},(_,i)=>'part'+i),['x'.repeat(512)+'\ud83d','\ude00'+'水'.repeat(100)]]
  const script=`const check=(value,message)=>{if(!value)throw Error(message)};
    for(const sample of ${JSON.stringify(cases)}){
      const backing=new Uint8Array(15).fill(165),view=backing.subarray(2,11);
      check(__qjsUTF8ByteLength(sample.text)===sample.length,'byteLength');
      check(__qjsWriteUTF8(sample.text,view,sample.offset,sample.limit)===sample.written,'written');
      check(JSON.stringify(Array.from(backing))===JSON.stringify(sample.bytes),'bytes');
    }
    for(const parts of ${JSON.stringify(ropes)}){
      let text='';for(const part of parts)text+=part;
      const reference=new Uint8Array(__qjsEncodeUTF8(text)),target=new Uint8Array(reference.length+6).fill(77);
      check(__qjsUTF8ByteLength(text)===reference.length,'rope length');
      check(__qjsWriteUTF8(text,target.subarray(3,-3),0,reference.length)===reference.length,'rope write');
      check(reference.every((byte,i)=>target[i+3]===byte)&&target[2]===77&&target[target.length-3]===77,'rope bytes');
    }
    const rejects=fn=>{try{fn()}catch{return}throw Error('expected rejection')};
    for(const value of [undefined,null,42,{},new String('abc')])rejects(()=>__qjsUTF8ByteLength(value));
    for(const view of [{},[],new Uint16Array(4),new Uint8ClampedArray(4),new DataView(new ArrayBuffer(4)),new Proxy(new Uint8Array(4),{})])rejects(()=>__qjsWriteUTF8('a',view,0,1));
    for(const pair of [[-1,1],[0,-1],[0.5,1],[0,0.5],[NaN,1],[Infinity,1],[0,Infinity],[4,1],[0,5],['0',1],[{},1]])rejects(()=>__qjsWriteUTF8('a',new Uint8Array(4),...pair));
    check(__qjsWriteUTF8('a',new Uint8Array(0),0,0)===0,'empty view');
    const detached=new Uint8Array(4);detachForTest(detached.buffer);rejects(()=>__qjsWriteUTF8('',detached,0,0));
    const shared=new Uint8Array(new SharedArrayBuffer(9));check(__qjsWriteUTF8('é水😀',shared,0,9)===9,'shared count');check(JSON.stringify(Array.from(shared))==='[195,169,230,176,180,240,159,152,128]','shared bytes');
    const rab=new ArrayBuffer(8,{maxByteLength:16}),tracking=new Uint8Array(rab);rab.resize(12);check(__qjsWriteUTF8('abcdefghij',tracking,2,10)===10,'resized tracking view');
    const fixed=new Uint8Array(rab,4,8);rab.resize(6);rejects(()=>__qjsWriteUTF8('',fixed,0,0));
  `
  const input=join(directory,'cases.js'),exe=join(directory,'native')
  writeFileSync(input,script)
  const args=['-O1','-g','-fsanitize=address','-fno-omit-frame-pointer','-D_GNU_SOURCE','-DCONFIG_VERSION="utf8-buffer-test"','-I'+qjs,resolve('tests/fixtures/native-utf8-buffer.c'),...['dtoa','libregexp','libunicode','cutils'].map(n=>join(qjs,n+'.c')),'-lm','-o',exe]
  const build=spawnSync(process.env.CC??'cc',args,{encoding:'utf8',timeout:120000});assert.equal(build.status,0,build.stdout+build.stderr)
  const run=spawnSync(exe,[input],{encoding:'utf8',timeout:60000,env:{...process.env,ASAN_OPTIONS:'abort_on_error=1'}})
  assert.equal(run.status,0,run.stdout+run.stderr);assert.equal(run.stderr,'');assert.match(run.stdout,/differential, no-output-allocation and cancellation passed/)
})
