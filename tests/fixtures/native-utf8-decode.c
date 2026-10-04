#include "quickjs.c"
#include "guest-native-utf8-decode.c"
#include <assert.h>
static int polls;
static int cancel(JSRuntime *rt, void *opaque) { return ++polls == 3; }
static JSValue detach(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv) {
    if (argc) JS_DetachArrayBuffer(ctx, argv[0]);
    return JS_UNDEFINED;
}
static void clear_exception(JSContext *ctx) { JS_FreeValue(ctx, JS_GetException(ctx)); }
int main(int argc, char **argv) {
    assert(argc == 2);
    JSRuntime *rt=JS_NewRuntime(); JSContext *ctx=JS_NewContext(rt); assert(rt && ctx);
    JSValue global=JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx,global,"decodeForTest",JS_NewCFunction(ctx,qjs_decode_utf8,"decode",3));
    JS_SetPropertyStr(ctx,global,"detachForTest",JS_NewCFunction(ctx,detach,"detach",1));
    JS_FreeValue(ctx,global);
    FILE *file=fopen(argv[1],"rb");assert(file);
    assert(!fseek(file,0,SEEK_END));long length=ftell(file);assert(length>=0&&length<32*1024*1024);rewind(file);
    char *source=js_malloc(ctx,length+1);assert(source);assert(fread(source,1,length,file)==(size_t)length);fclose(file);source[length]=0;
    JSValue result=JS_Eval(ctx,source,length,"decode-differential.js",JS_EVAL_TYPE_GLOBAL);js_free(ctx,source);
    if(JS_IsException(result)){JSValue e=JS_GetException(ctx);const char *s=JS_ToCString(ctx,e);fprintf(stderr,"%s\n",s?s:"exception");JS_FreeCString(ctx,s);JS_FreeValue(ctx,e);return 1;}JS_FreeValue(ctx,result);
    const int size=1024*1024;
    uint8_t *bytes=js_malloc(ctx,size);assert(bytes);memset(bytes,'x',size);
    JSValue backing=JS_NewArrayBufferCopy(ctx,bytes,size);js_free(ctx,bytes);assert(!JS_IsException(backing));
    JSValue params[]={backing,JS_NewInt32(ctx,0),JS_NewInt32(ctx,size)};
    JSValue view=JS_NewTypedArray(ctx,3,params,JS_TYPED_ARRAY_UINT8);assert(!JS_IsException(view));
    /* View owns backing after caller releases its handle. */
    JS_FreeValue(ctx,backing);
    JSValue args[]={view,JS_NewInt32(ctx,0),JS_NewInt32(ctx,size)};
    JS_RunGC(rt);JSMemoryUsage usage;JS_ComputeMemoryUsage(rt,&usage);JS_SetMemoryLimit(rt,usage.malloc_size+1024);
    result=qjs_decode_utf8(ctx,JS_UNDEFINED,3,args);assert(JS_IsException(result));clear_exception(ctx);JS_SetMemoryLimit(rt,SIZE_MAX);
    polls=0;JS_SetInterruptHandler(rt,cancel,NULL);
    result=qjs_decode_utf8(ctx,JS_UNDEFINED,3,args);assert(JS_IsException(result)&&polls==3);clear_exception(ctx);JS_SetInterruptHandler(rt,NULL,NULL);
    result=qjs_decode_utf8(ctx,JS_UNDEFINED,3,args);assert(!JS_IsException(result));assert(JS_VALUE_GET_STRING(result)->len==size);
    JS_FreeValue(ctx,result);JS_FreeValue(ctx,view);JS_FreeContext(ctx);JS_FreeRuntime(rt);
    puts("decode differential, quota, cancellation and backing ownership passed");return 0;
}
