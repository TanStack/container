import {readFileSync,writeFileSync} from 'node:fs'

export function stageNativeUTF8Buffer(path){
  let source=readFileSync(path,'utf8')
  if(source.includes('__qjsUTF8ByteLength')||source.includes('qjs_write_utf8'))throw Error('Native UTF-8 Buffer stage is already installed')
  if(!source.includes('static int qjs_utf8_next_code_point(')||!source.includes('static JSValue qjs_encode_utf8('))throw Error('Native UTF-8 Buffer stage requires native UTF-8 encoding')
  const replace=(before,after,label)=>{
    if(source.split(before).length!==2)throw Error('Unexpected native UTF-8 Buffer '+label+' integration site')
    source=source.replace(before,after)
  }
  const base='int JS_AddIntrinsicBaseObjects(JSContext *ctx)\n{\n    JSValue obj1, obj2;'
  replace(base,`static JSValue qjs_utf8_byte_length(JSContext *, JSValueConst, int, JSValueConst *);
static JSValue qjs_write_utf8(JSContext *, JSValueConst, int, JSValueConst *);
${base}
    if (JS_SetPropertyStr(ctx, ctx->global_obj, "__qjsUTF8ByteLength",
        JS_NewCFunction(ctx, qjs_utf8_byte_length, "utf8ByteLength", 1)) < 0) return -1;
    if (JS_SetPropertyStr(ctx, ctx->global_obj, "__qjsWriteUTF8",
        JS_NewCFunction(ctx, qjs_write_utf8, "writeUTF8", 4)) < 0) return -1;`,'base-object')
  replace('const char *hidden[] = {','const char *hidden[] = { "__qjsUTF8ByteLength", "__qjsWriteUTF8",','hidden-capabilities')
  writeFileSync(path,source+'\n'+readFileSync(new URL('../src/sandbox/guest-native-utf8-buffer.c',import.meta.url),'utf8'))
}
