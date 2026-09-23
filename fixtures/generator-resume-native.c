#include "quickjs.h"
#include <stdio.h>
#include <stdlib.h>

static int interrupt(JSRuntime *rt, void *opaque) {
    (void)rt;
    unsigned *ticks = opaque;
    return ++*ticks > 100000;
}

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    FILE *file = fopen(argv[1], "rb");
    if (!file) return 2;
    if (fseek(file, 0, SEEK_END)) return 2;
    long length = ftell(file);
    if (length < 0 || length > 1024 * 1024 || fseek(file, 0, SEEK_SET)) return 2;
    char *source = malloc((size_t)length + 1);
    if (!source) return 2;
    if (fread(source, 1, (size_t)length, file) != (size_t)length) return 2;
    fclose(file);
    source[length] = 0;
    JSRuntime *rt = JS_NewRuntime();
    if (!rt) return 2;
    JS_SetMemoryLimit(rt, 32 * 1024 * 1024);
    JS_SetMaxStackSize(rt, 512 * 1024);
    unsigned ticks = 0;
    JS_SetInterruptHandler(rt, interrupt, &ticks);
    JSContext *ctx = JS_NewContext(rt);
    if (!ctx) { JS_FreeRuntime(rt); free(source); return 2; }
    JSValue value = JS_Eval(ctx, source, (size_t)length, "probe.js", JS_EVAL_TYPE_GLOBAL);
    free(source);
    int failed = JS_IsException(value);
    if (failed) value = JS_GetException(ctx);
    const char *text = JS_ToCString(ctx, value);
    if (text) {
        fprintf(failed ? stderr : stdout, "%s\n", text);
        JS_FreeCString(ctx, text);
    } else failed = 1;
    JS_FreeValue(ctx, value);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    return failed ? 1 : 0;
}
