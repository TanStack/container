/* Included after QuickJS definitions. No guest getters, proxies or conversions
 * run while pointers into backing stores are live. */
static JSValue qjs_crypto_error(JSContext *ctx, int range, const char *code)
{
    if (range) JS_ThrowRangeError(ctx, "Input buffers must have the same byte length");
    else JS_ThrowTypeError(ctx, "Expected an ArrayBuffer or view");
    JSValue error = JS_GetException(ctx);
    if (JS_DefinePropertyValueStr(ctx, error, "code", JS_NewString(ctx, code), JS_PROP_C_W_E) < 0) {
        JS_FreeValue(ctx, error); return JS_EXCEPTION;
    }
    return JS_Throw(ctx, error);
}
static int qjs_crypto_bytes(JSValueConst value, const uint8_t **bytes, size_t *length)
{
    *bytes = NULL; *length = 0;
    if (!JS_IsObject(value)) return -1;
    JSObject *object = JS_VALUE_GET_OBJ(value);
    JSArrayBuffer *buffer;
    if (object->class_id == JS_CLASS_ARRAY_BUFFER || object->class_id == JS_CLASS_SHARED_ARRAY_BUFFER) {
        buffer = object->u.array_buffer;
        if (!buffer->detached) { *bytes = buffer->data; *length = buffer->byte_length; }
        return 0;
    }
    int typed = object->class_id >= JS_CLASS_UINT8C_ARRAY && object->class_id <= JS_CLASS_FLOAT64_ARRAY;
    if (!typed && object->class_id != JS_CLASS_DATAVIEW) return -1;
    JSTypedArray *view = object->u.typed_array;
    buffer = view->buffer->u.array_buffer;
    if (typed ? typed_array_is_oob(object) : dataview_is_oob(object)) return 0;
    *length = view->track_rab ? buffer->byte_length - view->offset : view->length;
    if (typed && view->track_rab) {
        size_t width = (size_t)1 << typed_array_size_log2(object->class_id);
        *length -= *length % width;
    }
    if (*length) *bytes = buffer->data + view->offset;
    return 0;
}
static JSValue qjs_crypto_timing_safe_equal(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    const uint8_t *left, *right;
    size_t left_length, right_length;
    if (argc < 2 || qjs_crypto_bytes(argv[0], &left, &left_length) < 0 ||
        qjs_crypto_bytes(argv[1], &right, &right_length) < 0)
        return qjs_crypto_error(ctx, 0, "ERR_INVALID_ARG_TYPE");
    if (left_length != right_length)
        return qjs_crypto_error(ctx, 1, "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH");
    /* Volatile reduction prevents replacing this loop with an early-exit
     * comparison. Work and addresses depend on length, not byte values.
     * Deadline checks are length-based and never execute guest JS. */
    volatile uint32_t difference = 0;
    for (size_t i = 0; i < left_length; i++) {
        if ((i & 65535) == 0 && js_poll_interrupts(ctx)) return JS_EXCEPTION;
        difference |= left[i] ^ right[i];
    }
    return JS_NewBool(ctx, difference == 0);
}
JSValue QJS_NewCrypto(JSContext *ctx)
{
    return JS_NewCFunction(ctx, qjs_crypto_timing_safe_equal, "timingSafeEqual", 2);
}
