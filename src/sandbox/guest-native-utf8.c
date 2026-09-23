/* Included after QuickJS definitions. This is a private, opt-in engine
 * capability. The embedder captures the function and removes the global before
 * guest code runs. Strings are immutable, and interrupt callbacks do not run
 * guest JavaScript, so direct JSString reads remain valid across polling. */
static int qjs_utf8_next_code_point(JSString *string, int *position, uint32_t *point)
{
    int current;
    if (string->is_wide_char) {
        current = string->u.str16[(*position)++];
        if (is_hi_surrogate(current)) {
            if (*position < string->len && is_lo_surrogate(string->u.str16[*position])) {
                current = from_surrogate(current, string->u.str16[(*position)++]);
            } else {
                current = 0xfffd;
            }
        } else if (is_lo_surrogate(current)) {
            current = 0xfffd;
        }
    } else {
        current = string->u.str8[(*position)++];
    }
    *point = (uint32_t)current;
    return current < 0x80 ? 1 : current < 0x800 ? 2 : current < 0x10000 ? 3 : 4;
}

static JSValue qjs_encode_utf8(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    JSString *string;
    JSValue flat;
    size_t length = 0, written = 0;
    uint8_t *bytes;
    int position = 0, last_poll = -65536;
    uint32_t point;

    if (argc < 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "UTF-8 input must be a string");
    /* JS_IsString also accepts ropes, whose payload is a tree rather than
     * character bytes. Normalize through QuickJS and retain the flat value
     * for both passes, including allocation and interrupt failure paths. */
    flat = JS_ToString(ctx, argv[0]);
    if (JS_IsException(flat)) return flat;
    string = JS_VALUE_GET_STRING(flat);

    while (position < string->len) {
        if (position - last_poll >= 65536) {
            if (__js_poll_interrupts(ctx)) {
                JS_FreeValue(ctx, flat);
                return JS_EXCEPTION;
            }
            last_poll = position;
        }
        int size = qjs_utf8_next_code_point(string, &position, &point);
        if (length > INT32_MAX - (size_t)size) {
            JS_FreeValue(ctx, flat);
            return JS_ThrowRangeError(ctx, "UTF-8 output exceeds ArrayBuffer limit");
        }
        length += (size_t)size;
    }

    bytes = js_malloc(ctx, length ? length : 1);
    if (!bytes) {
        JS_FreeValue(ctx, flat);
        return JS_EXCEPTION;
    }
    position = 0;
    last_poll = -65536;
    while (position < string->len) {
        if (position - last_poll >= 65536) {
            if (__js_poll_interrupts(ctx)) {
                js_free(ctx, bytes);
                JS_FreeValue(ctx, flat);
                return JS_EXCEPTION;
            }
            last_poll = position;
        }
        qjs_utf8_next_code_point(string, &position, &point);
        written += (size_t)unicode_to_utf8(bytes + written, point);
    }
    JS_FreeValue(ctx, flat);
    if (written != length) {
        js_free(ctx, bytes);
        return JS_ThrowInternalError(ctx, "UTF-8 encoder length mismatch");
    }

    JSValue result = JS_NewArrayBuffer(ctx, bytes, length,
                                       js_array_buffer_free, NULL, FALSE);
    if (JS_IsException(result)) js_free(ctx, bytes);
    return result;
}
