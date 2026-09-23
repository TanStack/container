import {readFileSync,writeFileSync} from 'node:fs'

// Install an opt-in private engine intrinsic. The source is included in the
// QuickJS translation unit so it can encode immutable JSString storage without
// a guest-host-guest round trip. All edits are exact and fail closed on drift.
export function stageNativeUTF8(path,bindingPath=new URL('../src/sandbox/guest-native-utf8.c',import.meta.url)){
  let source=readFileSync(path,'utf8')
  if(source.includes('__qjsEncodeUTF8')||source.includes('qjs_encode_utf8'))throw Error('Native UTF-8 stage is already installed')
  const replace=(before,after,label)=>{
    if(source.split(before).length!==2)throw Error('Unexpected native UTF-8 '+label+' integration site')
    source=source.replace(before,after)
  }
  const baseObjects='int JS_AddIntrinsicBaseObjects(JSContext *ctx)\n{\n    JSValue obj1, obj2;'
  replace(baseObjects,`static JSValue qjs_encode_utf8(JSContext *, JSValueConst, int, JSValueConst *);\n${baseObjects}\n    if (JS_SetPropertyStr(ctx, ctx->global_obj, "__qjsEncodeUTF8",\n        JS_NewCFunction(ctx, qjs_encode_utf8, "encodeUTF8", 1)) < 0) return -1;`,'base-object')
  replace('const char *hidden[] = {','const char *hidden[] = { "__qjsEncodeUTF8",','sandbox-hidden-capability')
  const binding=readFileSync(bindingPath,'utf8')
  if(!binding.includes('static JSValue qjs_encode_utf8(')||!binding.includes('__js_poll_interrupts(ctx)')||
    !binding.includes('JS_NewArrayBuffer(ctx, bytes, length'))throw Error('Unexpected native UTF-8 binding source')
  writeFileSync(path,source+'\n'+binding)
}
