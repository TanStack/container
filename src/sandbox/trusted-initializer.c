/* Host-only bridge. Do not register these functions on guest globals/modules.
 * Serialized bytes must originate from this exact engine's compile operation.
 * This is not a loader for project-provided or persisted bytecode. */
static JSValue *qts_compile_trusted_initializer(JSContext *ctx, JSValueConst *input, const char *filename) {
    size_t length = 0, size = 0;
    if (!JS_IsString(*input)) return jsvalue_to_heap(JS_ThrowTypeError(ctx, "Expected initializer source"));
    const char *source = JS_ToCStringLen(ctx, &length, *input);
    if (!source) return jsvalue_to_heap(JS_EXCEPTION);
    if (length > 2 * 1024 * 1024) {
        JS_FreeCString(ctx, source);
        return jsvalue_to_heap(JS_ThrowRangeError(ctx, "Initializer source limit exceeded"));
    }
    JSValue compiled = JS_Eval(ctx, source, length, filename, JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_COMPILE_ONLY);
    JS_FreeCString(ctx, source);
    if (JS_IsException(compiled)) return jsvalue_to_heap(compiled);
    uint8_t *bytes = JS_WriteObject(ctx, &size, compiled, JS_WRITE_OBJ_BYTECODE);
    JS_FreeValue(ctx, compiled);
    if (!bytes) return jsvalue_to_heap(JS_EXCEPTION);
    JSValue result = size > 8 * 1024 * 1024
        ? JS_ThrowRangeError(ctx, "Compiled initializer limit exceeded")
        : JS_NewArrayBufferCopy(ctx, bytes, size);
    js_free(ctx, bytes);
    return jsvalue_to_heap(result);
}

JSValue *QTS_CompileTrustedInitializer(JSContext *ctx, JSValueConst *input) {
    return qts_compile_trusted_initializer(ctx, input, "web-apis.js");
}

/* Separate ABI keeps older two-argument engines unambiguous. */
JSValue *QTS_CompileTrustedInitializerWithFilename(JSContext *ctx, JSValueConst *input, JSValueConst *name) {
    size_t length = 0;
    if (!JS_IsString(*name)) return jsvalue_to_heap(JS_ThrowTypeError(ctx, "Expected initializer filename"));
    const char *filename = JS_ToCStringLen(ctx, &length, *name);
    if (!filename) return jsvalue_to_heap(JS_EXCEPTION);
    if (!length || length > 4096 || memchr(filename, 0, length)) {
        JS_FreeCString(ctx, filename);
        return jsvalue_to_heap(JS_ThrowRangeError(ctx, "Invalid initializer filename"));
    }
    JSValue *result = qts_compile_trusted_initializer(ctx, input, filename);
    JS_FreeCString(ctx, filename);
    return result;
}

JSValue *QTS_EvalTrustedInitializer(JSContext *ctx, JSValueConst *input) {
    size_t size = 0;
    uint8_t *bytes = JS_GetArrayBuffer(ctx, &size, *input);
    if (!bytes) return jsvalue_to_heap(JS_EXCEPTION);
    if (!size || size > 8 * 1024 * 1024)
        return jsvalue_to_heap(JS_ThrowRangeError(ctx, "Compiled initializer limit exceeded"));
    JSValue compiled = JS_ReadObject(ctx, bytes, size, JS_READ_OBJ_BYTECODE);
    if (JS_IsException(compiled)) return jsvalue_to_heap(compiled);
    return jsvalue_to_heap(JS_EvalFunction(ctx, compiled));
}
