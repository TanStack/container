import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {stageNativeUTF8} from '../scripts/stage-native-utf8.mjs'

const baseObjects='int JS_AddIntrinsicBaseObjects(JSContext *ctx)\n{\n    JSValue obj1, obj2;'
const hidden='const char *hidden[] = { "__qjsCreateContext" };'

function fixture(source=baseObjects+'\n}\n'+hidden){
  const directory=mkdtempSync(join(tmpdir(),'native-utf8-stage-'))
  const path=join(directory,'quickjs.c')
  writeFileSync(path,source)
  return {directory,path}
}

test('native UTF8 stage installs one private, inherited-safe engine capability',()=>{
  const {directory,path}=fixture()
  try{
    stageNativeUTF8(path)
    const source=readFileSync(path,'utf8')
    assert.equal(source.match(/"__qjsEncodeUTF8"/g)?.length,2)
    assert.match(source,/JS_NewCFunction\(ctx, qjs_encode_utf8, "encodeUTF8", 1\)/)
    assert.match(source,/const char \*hidden\[\] = \{ "__qjsEncodeUTF8",/)
    assert.match(source,/argc < 1 \|\| !JS_IsString\(argv\[0\]\)/)
    assert.match(source,/flat = JS_ToString\(ctx, argv\[0\]\)/)
    assert.match(source,/if \(JS_IsException\(flat\)\) return flat/)
    assert.match(source,/string = JS_VALUE_GET_STRING\(flat\)/)
    assert.doesNotMatch(source,/string = JS_VALUE_GET_STRING\(argv\[0\]\)/)
    assert.match(source,/is_hi_surrogate\(current\)/)
    assert.match(source,/is_lo_surrogate\(current\)/)
    assert.match(source,/current = 0xfffd;/)
    assert.match(source,/position - last_poll >= 65536/g)
    assert.equal(source.match(/__js_poll_interrupts\(ctx\)/g)?.length,2)
    assert.match(source,/JS_NewArrayBuffer\(ctx, bytes, length,/)
    assert.match(source,/js_array_buffer_free, NULL, FALSE/)
    assert.throws(()=>stageNativeUTF8(path),/already installed/)
  }finally{rmSync(directory,{recursive:true,force:true})}
})

test('native UTF8 stage fails closed without changing drifted source',()=>{
  for(const [name,source] of [
    ['base-object','int JS_AddIntrinsicBaseObjects(JSContext *ctx) { return 0; }\n'+hidden],
    ['sandbox-hidden-capability',baseObjects+'\n}\n'],
  ]){
    const {directory,path}=fixture(source)
    try{
      assert.throws(()=>stageNativeUTF8(path),new RegExp(name))
      assert.equal(readFileSync(path,'utf8'),source)
    }finally{rmSync(directory,{recursive:true,force:true})}
  }
})

test('native UTF8 build flag has a distinct output and complete provenance contract',()=>{
  const source=readFileSync(new URL('../scripts/build-quickjs-als.mjs',import.meta.url),'utf8')
  for(const text of [
    "process.argv.includes('--native-utf8')",
    "(nativeUTF8?'-native-utf8':'')",
    "if(nativeUTF8)stageNativeUTF8(join(qjs,'quickjs.c'))",
    "intrinsic:'__qjsEncodeUTF8',operations:['encodeUTF8'],input:'string',output:'ArrayBuffer'",
    "interruptPollCodeUnits:65536,maxOutputBytes:2147483647",
  ])assert.ok(source.includes(text),text)
})
