/* Buffer-compatible non-streaming UTF-8. Requires qjs_utf8_buffer_index from
 * guest-native-utf8-buffer.c. No property access or coercion after storage is
 * acquired. StringBuffer allocations remain charged to the guest runtime. */
static JSValue qjs_decode_utf8(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    size_t start, end, view_offset, backing_length;
    unsigned needed = 0, seen = 0, point = 0, lower = 0x80, upper = 0xbf;
    if (argc < 3 || !JS_IsObject(argv[0]) ||
        JS_VALUE_GET_OBJ(argv[0])->class_id != JS_CLASS_UINT8_ARRAY)
        return JS_ThrowTypeError(ctx, "UTF-8 decode requires Uint8Array, start and end");
    if (qjs_utf8_buffer_index(ctx, argv[1], &start) ||
        qjs_utf8_buffer_index(ctx, argv[2], &end)) return JS_EXCEPTION;
    int view_length = js_typed_array_get_length_unsafe(ctx, argv[0]);
    if (view_length < 0) return JS_EXCEPTION;
    if (start > end || end > (size_t)view_length)
        return JS_ThrowRangeError(ctx, "UTF-8 decode range exceeds source view");
    JSValue backing = JS_GetTypedArrayBuffer(ctx, argv[0], &view_offset, NULL, NULL);
    if (JS_IsException(backing)) return backing;
    uint8_t *bytes = JS_GetArrayBuffer(ctx, &backing_length, backing);
    if ((!bytes && JS_HasException(ctx)) || view_offset > backing_length ||
        (size_t)view_length > backing_length - view_offset) {
        JS_FreeValue(ctx, backing);
        if (JS_HasException(ctx)) return JS_EXCEPTION;
        return JS_ThrowRangeError(ctx, "UTF-8 decode storage is out of bounds");
    }
    StringBuffer output;
    /* Small initial capacity avoids reserving two bytes per input byte. */
    if (string_buffer_init(ctx, &output, (int)(end - start < 256 ? end - start : 256))) {
        JS_FreeValue(ctx, backing);
        return string_buffer_end(&output);
    }
    size_t position = start, since_poll = 65536;
    while (position < end) {
        if (since_poll >= 65536) {
            if (__js_poll_interrupts(ctx)) goto fail;
            since_poll = 0;
        }
        unsigned byte = bytes[view_offset + position++];
        since_poll++;
        if (!needed) {
            if (byte <= 0x7f) {
                if (string_buffer_putc16(&output, byte)) goto fail;
            } else if (byte >= 0xc2 && byte <= 0xdf) {
                needed = 1; point = byte & 0x1f;
            } else if (byte >= 0xe0 && byte <= 0xef) {
                needed = 2; point = byte & 0x0f;
                if (byte == 0xe0) lower = 0xa0;
                if (byte == 0xed) upper = 0x9f;
            } else if (byte >= 0xf0 && byte <= 0xf4) {
                needed = 3; point = byte & 7;
                if (byte == 0xf0) lower = 0x90;
                if (byte == 0xf4) upper = 0x8f;
            } else if (string_buffer_putc16(&output, 0xfffd)) goto fail;
        } else if (byte < lower || byte > upper) {
            if (string_buffer_putc16(&output, 0xfffd)) goto fail;
            needed = seen = point = 0; lower = 0x80; upper = 0xbf;
            position--; /* Reprocess invalid continuation as a new lead. */
        } else {
            lower = 0x80; upper = 0xbf;
            point = (point << 6) | (byte & 0x3f);
            if (++seen == needed) {
                if (point > 0xffff) {
                    point -= 0x10000;
                    if (string_buffer_putc16(&output, (point >> 10) | 0xd800) ||
                        string_buffer_putc16(&output, (point & 0x3ff) | 0xdc00)) goto fail;
                } else if (string_buffer_putc16(&output, point)) goto fail;
                needed = seen = point = 0;
            }
        }
    }
    if (needed && string_buffer_putc16(&output, 0xfffd)) goto fail;
    JS_FreeValue(ctx, backing);
    return string_buffer_end(&output);
fail:
    string_buffer_free(&output);
    JS_FreeValue(ctx, backing);
    return JS_EXCEPTION;
}
