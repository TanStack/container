import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,cpSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import {stageNativeUTF8} from '../scripts/stage-native-utf8.mjs'
import {stageNativeUTF8Buffer} from '../scripts/stage-native-utf8-buffer.mjs'
import {decodeCases} from './fixtures/native-utf8-decode-cases.mjs'

test('standalone native decoder matches Node and preserves quotas and cancellation',()=>{
  const directory=mkdtempSync(join(tmpdir(),'utf8-decode-native-')),qjs=join(directory,'quickjs')
  cpSync(resolve('.toolchains/quickjs-emscripten/vendor/quickjs'),qjs,{recursive:true})
  stageNativeUTF8(join(qjs,'quickjs.c'));stageNativeUTF8Buffer(join(qjs,'quickjs.c'))
  const cases=decodeCases().map(bytes=>({bytes,expected:[Buffer.from(bytes).toString('utf8'),Buffer.from(bytes).toString('utf8',Math.min(1,bytes.length)),Buffer.from(bytes).toString('utf8',0,Math.max(0,bytes.length-1))]}))
  const script=`const check=(x,m)=>{if(!x)throw Error(m)};
  const rejects=f=>{try{f()}catch{return}throw Error('expected rejection')};
  for(const c of ${JSON.stringify(cases)}){
    const backing=Uint8Array.from([65,66,...c.bytes,67]),view=backing.subarray(2,2+c.bytes.length);
    for(const [i,start,end] of [[0,0,view.length],[1,Math.min(1,view.length),view.length],[2,0,Math.max(0,view.length-1)]])check(decodeForTest(view,start,end)===c.expected[i],'decode mismatch '+JSON.stringify(c.bytes));
  }
  for(const value of [{},[],new Uint16Array(2),new Uint8ClampedArray(2),new DataView(new ArrayBuffer(2)),new Proxy(new Uint8Array(2),{})])rejects(()=>decodeForTest(value,0,0));
  for(const pair of [[-1,0],[0,-1],[2,1],[0,3],[0.5,1],[0,Infinity],[NaN,1]])rejects(()=>decodeForTest(new Uint8Array(2),...pair));
  let coerced=false;rejects(()=>decodeForTest(new Uint8Array(2),{valueOf(){coerced=true;return 0}},1));check(!coerced,'coerced');
  const ab=new ArrayBuffer(4),view=new Uint8Array(ab);detachForTest(ab);rejects(()=>decodeForTest(view,0,0));
  const rab=new ArrayBuffer(8,{maxByteLength:16}),tracking=new Uint8Array(rab);rab.resize(12);tracking.fill(65);check(decodeForTest(tracking,2,12)==='A'.repeat(10),'tracking');
  const fixed=new Uint8Array(rab,4,8);rab.resize(6);rejects(()=>decodeForTest(fixed,0,0));
  check(decodeForTest(new Uint8Array(new SharedArrayBuffer(2)),0,2)==='\\0\\0','shared');
  check(decodeForTest(Uint8Array.from([239,187,191]),0,3)==='\\ufeff','BOM');`
  const input=join(directory,'cases.js');writeFileSync(input,script)
  const exe=join(directory,'decode-test')
  const args=['-O1','-g','-fsanitize=address','-fno-omit-frame-pointer','-D_GNU_SOURCE','-DCONFIG_VERSION="utf8-decode-test"','-I'+qjs,'-I'+resolve('src/sandbox'),resolve('tests/fixtures/native-utf8-decode.c'),...['dtoa','libregexp','libunicode','cutils'].map(n=>join(qjs,n+'.c')),'-lm','-o',exe]
  const built=spawnSync(process.env.CC??'cc',args,{encoding:'utf8',timeout:120000});assert.equal(built.status,0,built.stdout+built.stderr)
  const result=spawnSync(exe,[input],{encoding:'utf8',timeout:120000});assert.equal(result.status,0,result.stdout+result.stderr)
})
