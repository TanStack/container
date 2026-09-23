/* Local feasibility probe only. Bytes come exclusively from JS_WriteObject in
 * this process, never from an input file or guest. Not a runtime API. */
#include "quickjs.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten.h>

static void check(JSContext *ctx, JSValue value) {
    if (!JS_IsException(value)) return;
    JSValue error = JS_GetException(ctx);
    const char *message = JS_ToCString(ctx, error);
    fprintf(stderr, "%s\n", message ? message : "QuickJS error");
    JS_FreeCString(ctx, message);
    JS_FreeValue(ctx, error);
    exit(1);
}

static void verify_context(JSRuntime *runtime, JSContext *context) {
    const char *verify =
        "globalThis.__probeDone=false;"
        "(async()=>{"
        "const assert=(ok,label)=>{if(!ok)throw Error(label)};"
        "assert(Request.prototype.probe===undefined,'shared prototype');"
        "assert(new URL('https://example.com/a?q=42').searchParams.get('q')==='42','URL');"
        "const encoder=new TextEncoder(),decoder=new TextDecoder();"
        "assert(decoder.decode(encoder.encode('hello 🌍'))==='hello 🌍','UTF8');"
        "const headers=new Headers([['X-Answer','42']]);headers.append('x-answer','43');"
        "assert(headers.get('X-Answer')==='42, 43','headers');"
        "const request=new Request('https://example.com/',{method:'POST',body:'hello',headers});"
        "const cloned=request.clone();assert(await request.text()==='hello'&&await cloned.text()==='hello','clone');"
        "assert(request.bodyUsed&&cloned.bodyUsed,'bodyUsed');"
        "const blob=new Blob(['hello',' 🌍'],{type:'text/plain'});assert(await blob.text()==='hello 🌍','blob');"
        "const form=new FormData();form.append('a','1');form.append('a','2');"
        "assert(form.getAll('a').join(',')==='1,2','form');"
        "const stream=new ReadableStream({start(controller){controller.enqueue(encoder.encode('stream'));controller.close()}});"
        "assert(await new Response(stream).text()==='stream','stream response');"
        "let reason;const cancelled=new ReadableStream({cancel(value){reason=value}});"
        "await cancelled.cancel('done');assert(reason==='done','stream cancel');"
        "const controller=new AbortController();let events=0;controller.signal.addEventListener('abort',()=>events++);"
        "controller.abort('stop');assert(controller.signal.aborted&&controller.signal.reason==='stop'&&events===1,'abort');"
        "Request.prototype.probe=42;return JSON.stringify({request:Request.name,response:Response.name});"
        "})().then(value=>{globalThis.__probeResult=value;globalThis.__probeDone=true},error=>{globalThis.__probeError=String(error);globalThis.__probeDone=true});";
    JSValue result = JS_Eval(context, verify, strlen(verify), "verify.js", JS_EVAL_TYPE_GLOBAL);
    check(context, result);JS_FreeValue(context, result);
    JSContext *job_context = NULL;
    for (int i = 0; i < 1000 && JS_IsJobPending(runtime); i++) {
        if (JS_ExecutePendingJob(runtime, &job_context) < 0) check(job_context, JS_EXCEPTION);
    }
    const char *finish = "if(!globalThis.__probeDone)throw Error('probe did not settle');"
        "if(globalThis.__probeError)throw Error(globalThis.__probeError);globalThis.__probeResult";
    result = JS_Eval(context, finish, strlen(finish), "finish.js", JS_EVAL_TYPE_GLOBAL);
    check(context, result);
    const char *output = JS_ToCString(context, result);
    printf("%s\n", output);JS_FreeCString(context, output);JS_FreeValue(context, result);
}

static int run_source(char *source, size_t length);

#ifdef QTS_INITIALIZER_PROBE_EXPORT
int QTS_ProbeCompiledInitializer(const char *input, size_t length) {
    if (!input || length > 2 * 1024 * 1024) return 2;
    char *source = malloc(length + 1);
    if (!source) return 2;
    memcpy(source, input, length);source[length] = 0;
    return run_source(source, length);
}
#else
int main(int argc, char **argv) {
    if (argc != 2) return 2;
    FILE *file = fopen(argv[1], "rb");
    if (!file || fseek(file, 0, SEEK_END)) return 2;
    long length = ftell(file);
    if (length < 0 || length > 2 * 1024 * 1024 || fseek(file, 0, SEEK_SET)) return 2;
    char *source = malloc((size_t)length + 1);
    if (!source || fread(source, 1, length, file) != (size_t)length) return 2;
    fclose(file);source[length] = 0;
    return run_source(source, (size_t)length);
}
#endif

static int run_source(char *source, size_t length) {
    JSRuntime *runtime = JS_NewRuntime();
    JS_SetMemoryLimit(runtime, 128 * 1024 * 1024);
    JSContext *context = JS_NewContext(runtime);
    double start = emscripten_get_now();
    JSValue baseline = JS_Eval(context, source, length, "web-apis.js", JS_EVAL_TYPE_GLOBAL);
    check(context, baseline);JS_FreeValue(context, baseline);
    fprintf(stderr, "{\"phase\":\"source-evaluation\",\"ms\":%.3f}\n", emscripten_get_now()-start);
    verify_context(runtime, context);
    JS_FreeContext(context);JS_FreeRuntime(runtime);
    runtime = JS_NewRuntime();JS_SetMemoryLimit(runtime, 128 * 1024 * 1024);
    context = JS_NewContext(runtime);start = emscripten_get_now();
    JSValue compiled = JS_Eval(context, source, length, "web-apis.js", JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_COMPILE_ONLY);
    free(source);check(context, compiled);
    size_t size = 0;
    uint8_t *bytes = JS_WriteObject(context, &size, compiled, JS_WRITE_OBJ_BYTECODE);
    if (!bytes) { check(context, JS_EXCEPTION); return 1; }
    uint8_t *copy = malloc(size);
    if (!copy) return 2;
    memcpy(copy, bytes, size);js_free(context, bytes);
    fprintf(stderr, "{\"phase\":\"compile-and-serialize\",\"ms\":%.3f}\n", emscripten_get_now()-start);
    JS_FreeValue(context, compiled);JS_FreeContext(context);JS_FreeRuntime(runtime);
    /* The producer runtime is gone before any consumer loads the bytes. */
    for (int i = 0; i < 3; i++) {
        runtime = JS_NewRuntime();JS_SetMemoryLimit(runtime, 128 * 1024 * 1024);
        context = JS_NewContext(runtime);
        start = emscripten_get_now();
        JSValue loaded = JS_ReadObject(context, copy, size, JS_READ_OBJ_BYTECODE);
        check(context, loaded);
        JSValue result = JS_EvalFunction(context, loaded);check(context, result);JS_FreeValue(context, result);
        fprintf(stderr, "{\"phase\":\"load-and-evaluate\",\"index\":%d,\"ms\":%.3f}\n", i, emscripten_get_now()-start);
        verify_context(runtime, context);
        JS_FreeContext(context);JS_FreeRuntime(runtime);
    }
    fprintf(stderr, "Serialized bytes: %zu\n", size);free(copy);return 0;
}
