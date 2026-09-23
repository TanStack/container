/* Opt-in companions to qjs_encode_utf8. Reuse its scalar decoder, including
 * replacement of lone surrogates. Count/write never allocate encoded output. */
static JSValue qjs_utf8_byte_length(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    if (argc < 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "UTF-8 input must be a string");
    JSValue flat = JS_ToString(ctx, argv[0]);
    if (JS_IsException(flat)) return flat;
    JSString *string = JS_VALUE_GET_STRING(flat);
    uint64_t length = 0;
    int position = 0, last_poll = -65536;
    uint32_t point;
    while (position < string->len) {
        if (position - last_poll >= 65536) {
            if (__js_poll_interrupts(ctx)) { JS_FreeValue(ctx, flat); return JS_EXCEPTION; }
            last_poll = position;
        }
        length += qjs_utf8_next_code_point(string, &position, &point);
    }
    JS_FreeValue(ctx, flat);
    /* At most three bytes per UTF-16 unit, exactly representable as a Number. */
    return JS_NewFloat64(ctx, (double)length);
}

static int qjs_utf8_buffer_index(JSContext *ctx, JSValueConst value, size_t *result)
{
    double number;
    /* Do not coerce objects: that could execute guest JS or detach the target. */
    if (!JS_IsNumber(value)) { JS_ThrowTypeError(ctx, "UTF-8 range must be a number"); return -1; }
    if (JS_ToFloat64(ctx, &number, value)) return -1;
    if (!isfinite(number) || number < 0 || number > INT32_MAX || trunc(number) != number) {
        JS_ThrowRangeError(ctx, "UTF-8 range must be a non-negative integer"); return -1;
    }
    *result = (size_t)number;
    return 0;
}

static JSValue qjs_write_utf8(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    size_t offset, limit, view_offset, backing_length, written = 0;
    int position = 0, last_poll = -65536;
    uint32_t point;
    if (argc < 4 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "UTF-8 write requires a string, Uint8Array, offset and limit");
    if (!JS_IsObject(argv[1]) || JS_VALUE_GET_OBJ(argv[1])->class_id != JS_CLASS_UINT8_ARRAY)
        return JS_ThrowTypeError(ctx, "UTF-8 target must be a Uint8Array");
    if (qjs_utf8_buffer_index(ctx, argv[2], &offset) || qjs_utf8_buffer_index(ctx, argv[3], &limit))
        return JS_EXCEPTION;
    /* Retain a flat string before acquiring target storage. Rope flattening may
     * allocate. Afterwards only immutable reads, checked native accessors and
     * interruption polls occur, never a property lookup or guest JS callback. */
    JSValue flat = JS_ToString(ctx, argv[0]);
    if (JS_IsException(flat)) return flat;
    int view_length = js_typed_array_get_length_unsafe(ctx, argv[1]);
    if (view_length < 0) { JS_FreeValue(ctx, flat); return JS_EXCEPTION; }
    if (offset > (size_t)view_length || limit > (size_t)view_length - offset) {
        JS_FreeValue(ctx, flat);
        return JS_ThrowRangeError(ctx, "UTF-8 range exceeds target view");
    }
    JSValue backing = JS_GetTypedArrayBuffer(ctx, argv[1], &view_offset, NULL, NULL);
    if (JS_IsException(backing)) { JS_FreeValue(ctx, flat); return backing; }
    uint8_t *bytes = JS_GetArrayBuffer(ctx, &backing_length, backing);
    if ((!bytes && JS_HasException(ctx)) || view_offset > backing_length ||
        (size_t)view_length > backing_length - view_offset) {
        JS_FreeValue(ctx, backing); JS_FreeValue(ctx, flat);
        if (JS_HasException(ctx)) return JS_EXCEPTION;
        return JS_ThrowRangeError(ctx, "UTF-8 target storage is out of bounds");
    }
    JSString *string = JS_VALUE_GET_STRING(flat);
    while (position < string->len && written < limit) {
        if (position - last_poll >= 65536) {
            if (__js_poll_interrupts(ctx)) {
                JS_FreeValue(ctx, backing); JS_FreeValue(ctx, flat); return JS_EXCEPTION;
            }
            last_poll = position;
        }
        int size = qjs_utf8_next_code_point(string, &position, &point);
        if ((size_t)size > limit - written) break;
        /* Valid zero-length storage never reaches this pointer arithmetic. */
        written += unicode_to_utf8(bytes + view_offset + offset + written, point);
    }
    JS_FreeValue(ctx, backing); JS_FreeValue(ctx, flat);
    return JS_NewInt64(ctx, written);
}
