#include "quickjs.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void check_result(JSContext *ctx, JSValue value) {
    if (JS_IsException(value)) {
        JSValue error = JS_GetException(ctx);
        const char *text = JS_ToCString(ctx, error);
        fprintf(stderr, "%s\n", text ? text : "guest exception");
        exit(2);
    }
    JS_FreeValue(ctx, value);
}

static void evaluate(JSContext *ctx, const char *source) {
    check_result(ctx, JS_Eval(ctx, source, strlen(source), "weakmap.js", 0));
}

static void call(JSContext *ctx, JSValue fn, JSValue receiver) {
    check_result(ctx, JS_Call(ctx, fn, receiver, 0, NULL));
}

static void collect(JSRuntime *rt) {
    JS_RunGC(rt);
    JS_RunGC(rt);
    JSContext *ctx;
    for (int jobs = 0; JS_IsJobPending(rt); jobs++) {
        if (jobs >= 1024) { fprintf(stderr, "job quota\n"); exit(2); }
        if (JS_ExecutePendingJob(rt, &ctx) < 0) check_result(ctx, JS_EXCEPTION);
    }
}

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    FILE *file = fopen(argv[1], "rb");
    if (!file) return 2;
    if (fseek(file, 0, SEEK_END)) return 2;
    long length = ftell(file);
    if (length < 1 || length > 1024 * 1024) return 2;
    rewind(file);
    char *source = malloc((size_t)length + 1);
    if (!source || fread(source, 1, (size_t)length, file) != (size_t)length) return 2;
    fclose(file);
    source[length] = 0;
    printf("[");
    int count = 0;
    for (int index = 0; !index || index < count; index++) {
        JSRuntime *rt = JS_NewRuntime();
        if (!rt) return 2;
        JS_SetMemoryLimit(rt, 16 * 1024 * 1024);
        JSContext *ctx = JS_NewContext(rt);
        if (!ctx) return 2;
        evaluate(ctx, source);
        JSValue global = JS_GetGlobalObject(ctx);
        JSValue cases = JS_GetPropertyStr(ctx, global, "cases");
        JSValue size = JS_GetPropertyStr(ctx, cases, "length");
        if (JS_ToInt32(ctx, &count, size) || count < 1 || count > 100) return 2;
        JS_FreeValue(ctx, size);
        JSValue factory = JS_GetPropertyUint32(ctx, cases, index);
        JSValue test = JS_Call(ctx, factory, JS_UNDEFINED, 0, NULL);
        if (JS_IsException(test)) { check_result(ctx, test); return 2; }
        JSValue step = JS_GetPropertyStr(ctx, test, "step");
        JSValue check = JS_GetPropertyStr(ctx, test, "check");
        JSValue release = JS_GetPropertyStr(ctx, test, "release");
        JS_RunGC(rt);
        JSMemoryUsage before, after;
        JS_ComputeMemoryUsage(rt, &before);
        for (int round = 0; round < 64; round++) {
            fprintf(stderr, "weakmap case %d round %d\n", index, round);
            call(ctx, step, test);
            /* A second GC removes zombie weak references from the first,
               then pending finalization jobs are drained explicitly. */
            collect(rt);
            call(ctx, check, test);
        }
        call(ctx, release, test);
        collect(rt);
        JS_ComputeMemoryUsage(rt, &after);
        printf("%s{\"index\":%d,\"growth\":%lld}", index ? "," : "", index,
               (long long)(after.malloc_size - before.malloc_size));
        fflush(stdout);
        JS_FreeValue(ctx, release);
        JS_FreeValue(ctx, check);
        JS_FreeValue(ctx, step);
        JS_FreeValue(ctx, test);
        JS_FreeValue(ctx, factory);
        JS_FreeValue(ctx, cases);
        JS_FreeValue(ctx, global);
        JS_FreeContext(ctx);
        JS_FreeRuntime(rt);
    }
    free(source);
    printf("]\n");
    return 0;
}
