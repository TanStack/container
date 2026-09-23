#include "quickjs.c"
#include <assert.h>

static int poll_count;
static int cancel_poll(JSRuntime *rt, void *opaque) { (void)rt; (void)opaque; return ++poll_count == 3; }
static JSValue detach(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    if(argc) JS_DetachArrayBuffer(ctx, argv[0]);
    return JS_UNDEFINED;
}
static void check_result(JSContext *ctx, JSValue result, int expected)
{
    assert(!JS_IsException(result));
    int64_t count; assert(JS_ToInt64(ctx, &count, result) == 0 && count == expected);
    JS_FreeValue(ctx, result);
}
int main(int argc, char **argv)
{
    assert(argc == 2);
    JSRuntime *rt = JS_NewRuntime(); JSContext *ctx = JS_NewContext(rt);
    assert(rt && ctx);
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "detachForTest", JS_NewCFunction(ctx, detach, "detach", 1));
    JS_FreeValue(ctx, global);
    FILE *input = fopen(argv[1], "rb"); assert(input);
    assert(fseek(input, 0, SEEK_END) == 0); long length = ftell(input); assert(length >= 0 && length < 2*1024*1024);
    rewind(input); char *source = js_malloc(ctx, length + 1); assert(source);
    assert(fread(source, 1, length, input) == (size_t)length); fclose(input); source[length] = 0;
    JSValue result = JS_Eval(ctx, source, length, "buffer-differential.js", JS_EVAL_TYPE_GLOBAL);
    js_free(ctx, source);
    if(JS_IsException(result)) {
        JSValue exception=JS_GetException(ctx); const char *message=JS_ToCString(ctx,exception);
        fprintf(stderr,"%s\n",message?message:"guest exception");JS_FreeCString(ctx,message);JS_FreeValue(ctx,exception);return 1;
    }
    JS_FreeValue(ctx, result);

    const size_t size=1024*1024;
    uint8_t *bytes=js_malloc(ctx,size);assert(bytes);memset(bytes,'x',size);
    JSValue string=JS_NewStringLen(ctx,(const char *)bytes,size),backing=JS_NewArrayBufferCopy(ctx,bytes,size);
    js_free(ctx,bytes);assert(!JS_IsException(string)&&!JS_IsException(backing));
    JSValue view_args[]={backing,JS_NewInt32(ctx,0),JS_NewInt32(ctx,size)};
    JSValue view=JS_NewTypedArray(ctx,3,view_args,JS_TYPED_ARRAY_UINT8);assert(!JS_IsException(view));
    JSValue args[]={string,view,JS_NewInt32(ctx,0),JS_NewInt32(ctx,size)};
    JSMemoryUsage usage;JS_RunGC(rt);JS_ComputeMemoryUsage(rt,&usage);
    JS_SetMemoryLimit(rt,usage.malloc_size+512);
    check_result(ctx,qjs_utf8_byte_length(ctx,JS_UNDEFINED,1,&string),size);
    check_result(ctx,qjs_write_utf8(ctx,JS_UNDEFINED,4,args),size);
    /* The existing allocating encoder fails under the same budget. */
    result=qjs_encode_utf8(ctx,JS_UNDEFINED,1,&string);assert(JS_IsException(result));JS_FreeValue(ctx,JS_GetException(ctx));
    JS_SetMemoryLimit(rt,SIZE_MAX);
    for(int operation=0;operation<2;operation++){
        poll_count=0;JS_SetInterruptHandler(rt,cancel_poll,NULL);
        result=operation?qjs_write_utf8(ctx,JS_UNDEFINED,4,args):qjs_utf8_byte_length(ctx,JS_UNDEFINED,1,&string);
        assert(JS_IsException(result)&&poll_count==3);JS_FreeValue(ctx,JS_GetException(ctx));JS_SetInterruptHandler(rt,NULL,NULL);
        check_result(ctx,qjs_utf8_byte_length(ctx,JS_UNDEFINED,1,&string),size);
        check_result(ctx,qjs_write_utf8(ctx,JS_UNDEFINED,4,args),size);
    }
    JS_FreeValue(ctx,view);JS_FreeValue(ctx,backing);JS_FreeValue(ctx,string);
    JS_FreeContext(ctx);JS_FreeRuntime(rt);
    puts("native UTF8 Buffer differential, no-output-allocation and cancellation passed");
    return 0;
}
