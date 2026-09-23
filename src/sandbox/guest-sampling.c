/* Diagnostic-only branch samples. Never allocate, enter JS, resolve names through
 * properties, or retain borrowed storage at a poll. Host reads happen outside an
 * active fiber. Runtime teardown owns the fixed buffer, separate from guest GC. */
#ifdef QJS_GUEST_SAMPLING
#ifndef QJS_GUEST_SAMPLING_NOW
#define QJS_GUEST_SAMPLING_NOW() qjs_script_now()
#endif
#define QJS_GUEST_SAMPLE_MAX 512
#define QJS_GUEST_SAMPLE_INTERVAL 20
#define QJS_GUEST_SAMPLE_NAME 96
#define QJS_GUEST_SAMPLE_FILE 192
typedef struct {
    double at;
    uint64_t sequence;
    int offset, bytecode_length, flags, name_length, file_length;
    char name[QJS_GUEST_SAMPLE_NAME], file[QJS_GUEST_SAMPLE_FILE];
} QJSGuestSample;
typedef struct QJSGuestSampling {
    unsigned count;
    uint64_t total;
    double last;
    QJSGuestSample records[QJS_GUEST_SAMPLE_MAX];
} QJSGuestSampling;

static void qjs_guest_sampling_dispose(JSRuntime *rt)
{
    qjs_guest_sampling_host_free(rt->guest_sampling);
    rt->guest_sampling = NULL;
}

/* Allocation occurs only at the explicit host setup boundary, never at a poll.
 * Returns 1 enabled, 0 disabled, -1 allocation failure. Reset invalidates Text. */
int QJS_GuestSamplingReset(JSRuntime *rt, int enabled)
{
    if (!enabled) { qjs_guest_sampling_dispose(rt); return 0; }
    if (!rt->guest_sampling) rt->guest_sampling = calloc(1, sizeof(QJSGuestSampling));
    if (!rt->guest_sampling) return -1;
    memset(rt->guest_sampling, 0, sizeof(QJSGuestSampling));
    rt->guest_sampling->last = -INFINITY;
    return 1;
}
int QJS_GuestSamplingCount(JSRuntime *rt)
{
    return rt->guest_sampling ? (int)rt->guest_sampling->count : 0;
}
double QJS_GuestSamplingRead(JSRuntime *rt, int index, int field)
{
    if (!rt->guest_sampling || index < 0 || (unsigned)index >= rt->guest_sampling->count) return -1;
    QJSGuestSampling *sampling = rt->guest_sampling;
    QJSGuestSample *s = &sampling->records[(sampling->total - sampling->count + index) % QJS_GUEST_SAMPLE_MAX];
    switch (field) {
    case 0: return s->at;
    case 1: return s->offset;
    case 2: return s->bytecode_length;
    case 3: return s->flags;
    case 4: return s->name_length;
    case 5: return s->file_length;
    case 6: return (double)s->sequence;
    default: return -1;
    }
}
const char *QJS_GuestSamplingText(JSRuntime *rt, int index, int kind)
{
    if (!rt->guest_sampling || index < 0 || (unsigned)index >= rt->guest_sampling->count) return NULL;
    QJSGuestSampling *sampling = rt->guest_sampling;
    QJSGuestSample *s = &sampling->records[(sampling->total - sampling->count + index) % QJS_GUEST_SAMPLE_MAX];
    return kind == 0 ? s->name : kind == 1 ? s->file : NULL;
}

/* Atoms are flat immutable engine strings. Copy only a bounded prefix directly,
 * including valid UTF-8 for UTF-16 names. No borrowed pointer escapes this call. */
static int qjs_guest_sampling_atom(JSRuntime *rt, JSAtom atom, char *out, int capacity, int *truncated)
{
    int written = 0;
    out[0] = 0;
    if (atom == JS_ATOM_NULL || __JS_AtomIsTaggedInt(atom) || atom >= rt->atom_size) return 0;
    JSAtomStruct *str = rt->atom_array[atom];
    if (!str || atom_is_free(str)) return 0;
    uint32_t i = 0;
    while (i < str->len && written < capacity - 1) {
        uint32_t c = string_get(str, i++);
        uint8_t bytes[4];
        int count;
        if (c >= 0xd800 && c <= 0xdbff && i < str->len) {
            uint32_t low = string_get(str, i);
            if (low >= 0xdc00 && low <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + low - 0xdc00; i++; }
        }
        if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
        /* Embedded NUL would hide the remaining text from host C-string readers. */
        if (!c) c = 0xfffd;
        count = unicode_to_utf8(bytes, c);
        if (written + count >= capacity) { *truncated = 1; break; }
        memcpy(out + written, bytes, count);
        written += count;
    }
    if (i < str->len) *truncated = 1;
    out[written] = 0;
    return written;
}

static int qjs_guest_sampling_poll(JSContext *ctx, JSFunctionBytecode *b, const uint8_t *pc)
{
    /* Exactly the original poll counter and cancellation order. */
    if (unlikely(--ctx->interrupt_counter <= 0)) {
        int result = __js_poll_interrupts(ctx);
        if (result) return result;
        QJSGuestSampling *sampling = ctx->rt->guest_sampling;
        if (sampling) {
            double now = QJS_GUEST_SAMPLING_NOW();
            if (now - sampling->last >= QJS_GUEST_SAMPLE_INTERVAL) {
                QJSGuestSample *s = &sampling->records[sampling->total % QJS_GUEST_SAMPLE_MAX];
                int truncated = 0;
                memset(s, 0, sizeof(*s));
                s->sequence = ++sampling->total;
                if (sampling->count < QJS_GUEST_SAMPLE_MAX) sampling->count++;
                sampling->last = now;
                s->at = now;
                s->bytecode_length = b->byte_code_len;
                /* Branch destination, not JSStackFrame.cur_pc's stale call site. */
                uintptr_t address = (uintptr_t)pc, base = (uintptr_t)b->byte_code_buf;
                s->offset = address >= base && address - base < (uintptr_t)b->byte_code_len ? (int)(address - base) : -1;
                if (s->offset < 0) s->flags |= 8;
                s->name_length = qjs_guest_sampling_atom(ctx->rt, b->func_name, s->name, sizeof(s->name), &truncated);
                if (truncated) s->flags |= 1;
                if (b->has_debug) {
                    truncated = 0;
                    s->file_length = qjs_guest_sampling_atom(ctx->rt, b->debug.filename, s->file, sizeof(s->file), &truncated);
                    if (truncated) s->flags |= 2;
                } else s->flags |= 4;
            }
        }
    }
    return 0;
}
#endif
