#include "quickjs.h"
#include <stdio.h>
#include <string.h>

static int evaluate(JSContext *ctx, const char *code)
{
    JSValue value = JS_Eval(ctx, code, strlen(code), "capture-allocation.js", JS_EVAL_TYPE_GLOBAL);
    int failed = JS_IsException(value);
    if (failed) JS_FreeValue(ctx, JS_GetException(ctx));
    JS_FreeValue(ctx, value);
    return failed;
}
int main(void)
{
    int failures = 0, successes = 0;
    const char *source = "(()=>{Error.prepareStackTrace=(e,s)=>s;function inner(){let e={};Error.captureStackTrace(e);e.frames=e.stack;return e}let e=inner();if(e.frames[0].getFunctionName()!=='inner')throw Error('wrong frame');globalThis.retained=e.frames;e=null})()";
    for (int extra = 0; extra <= 65536; extra += 128) {
        JSRuntime *rt = JS_NewRuntime();
        JSContext *ctx = JS_NewContext(rt);
        JSMemoryUsage usage;
        JS_ComputeMemoryUsage(rt, &usage);
        JS_SetMemoryLimit(rt, usage.malloc_size + extra);
        if (evaluate(ctx, source)) failures++; else successes++;
        JS_SetMemoryLimit(rt, 32 * 1024 * 1024);
        if (evaluate(ctx, source)) { fprintf(stderr, "recovery failed at %d\n", extra); return 1; }
        JS_RunGC(rt);
        if (evaluate(ctx, "if(retained[0].getFunctionName()!=='inner')throw Error('lost retained frame');retained=null")) return 2;
        JS_RunGC(rt);
        JS_FreeContext(ctx);
        JS_FreeRuntime(rt);
    }
    printf("{\"attempts\":%d,\"allocationFailures\":%d,\"successes\":%d}\n", failures + successes, failures, successes);
    return !failures || !successes;
}
