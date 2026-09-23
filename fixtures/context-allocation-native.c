#include "quickjs.h"
#include <stdio.h>

/* Native sanitizer counterpart to the WASM allocation-failure probe. */
int main(void) {
    int failed = 0, passed = 0;
    for (int extra = 0; extra <= 131072; extra += 128) {
        JSRuntime *rt = JS_NewRuntime();
        JSContext *ctx = JS_NewContext(rt);
        JSValue global = JS_GetGlobalObject(ctx);
        JSValue factory = JS_GetPropertyStr(ctx, global, "__qjsCreateContext");
        JSValue args[2] = {JS_NewObject(ctx), JS_TRUE};
        JSMemoryUsage usage;
        JS_ComputeMemoryUsage(rt, &usage);
        JS_SetMemoryLimit(rt, usage.memory_used_size + extra);
        JSValue result = JS_Call(ctx, factory, JS_UNDEFINED, 2, args);
        JS_SetMemoryLimit(rt, 16 * 1024 * 1024);
        if (JS_IsException(result)) {
            failed++;
            JS_FreeValue(ctx, JS_GetException(ctx));
        } else passed++;
        JS_FreeValue(ctx, result);
        JS_FreeValue(ctx, args[0]);
        JS_FreeValue(ctx, factory);
        JS_FreeValue(ctx, global);
        JS_FreeContext(ctx);
        JS_FreeRuntime(rt);
    }
    printf("{\"attempts\":%d,\"allocationFailures\":%d,\"successes\":%d}\n", failed + passed, failed, passed);
    return failed && passed ? 0 : 1;
}
