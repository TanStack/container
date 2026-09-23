#include <assert.h>
#include <stdio.h>
static double sample_clock, sample_increment;
static double sampling_now(void) { double value = sample_clock; sample_clock += sample_increment; return value; }
#define QJS_GUEST_SAMPLING_NOW() sampling_now()
#include "quickjs.c"

static int interruptions;
static int interrupt_after_three(JSRuntime *rt, void *opaque) { (void)rt; (void)opaque; return ++interruptions >= 3; }
static void finite(JSContext *ctx)
{
    const char *source = "function busy(){let n=0;for(let i=0;i<6000000;i++)n+=i;return n} Object.defineProperty(busy,'name',{get(){throw Error('sampler invoked name getter')}});busy()";
    JSValue result = JS_Eval(ctx, source, strlen(source), "sampling-fixture.js", JS_EVAL_TYPE_GLOBAL);
    assert(!JS_IsException(result));
    double number; assert(JS_ToFloat64(ctx, &number, result) == 0 && number == 17999997000000.0);
    JS_FreeValue(ctx, result);
}
int main(void)
{
    JSRuntime *rt = JS_NewRuntime(), *peer = JS_NewRuntime();
    JSContext *ctx = JS_NewContext(rt), *peer_ctx = JS_NewContext(peer);
    assert(rt && peer && ctx && peer_ctx);
    finite(ctx);
#ifdef QJS_GUEST_SAMPLING
    assert(sizeof(QJSGuestSampling) <= 172064);
    assert(QJS_GuestSamplingCount(rt) == 0);
    assert(QJS_GuestSamplingReset(rt, 1) == 1);
    sample_increment = 20;
    finite(ctx);
    assert(QJS_GuestSamplingCount(rt) == 512);
    assert(QJS_GuestSamplingRead(rt, 0, 6) > 1);
    assert(QJS_GuestSamplingRead(rt, 511, 6) - QJS_GuestSamplingRead(rt, 0, 6) == 511);
    for (int i = 0; i < 512; i++) {
        assert(!strcmp(QJS_GuestSamplingText(rt, i, 0), "busy"));
        assert(!strcmp(QJS_GuestSamplingText(rt, i, 1), "sampling-fixture.js"));
        assert(QJS_GuestSamplingRead(rt, i, 1) >= 0);
        assert(QJS_GuestSamplingRead(rt, i, 1) < QJS_GuestSamplingRead(rt, i, 2));
        assert(QJS_GuestSamplingRead(rt, i, 3) == 0);
        if (i) assert(QJS_GuestSamplingRead(rt, i, 0) - QJS_GuestSamplingRead(rt, i-1, 0) == 20);
    }
    double last = QJS_GuestSamplingRead(rt, 511, 6);
    assert(QJS_GuestSamplingCount(peer) == 0);
    assert(QJS_GuestSamplingReset(peer, 1) == 1);
    finite(peer_ctx);
    assert(QJS_GuestSamplingCount(peer) == 512);
    assert(QJS_GuestSamplingRead(rt, 511, 6) == last);
    assert(QJS_GuestSamplingReset(peer, 0) == 0);
    assert(QJS_GuestSamplingRead(rt, 511, 6) == last);

    /* Interval, reset and invalid reads use no wall-clock delays. */
    QJS_GuestSamplingReset(rt, 1); sample_increment = 0; sample_clock = 0;
    finite(ctx); assert(QJS_GuestSamplingCount(rt) == 1);
    sample_clock = 19; finite(ctx); assert(QJS_GuestSamplingCount(rt) == 1);
    sample_clock = 20; finite(ctx); assert(QJS_GuestSamplingCount(rt) == 2);
    assert(QJS_GuestSamplingRead(rt, 0, 6) == 1);
    assert(QJS_GuestSamplingRead(rt, -1, 0) == -1);
    assert(QJS_GuestSamplingRead(rt, 2, 0) == -1);
    assert(QJS_GuestSamplingText(rt, 0, 2) == NULL);
    /* Long and wide atom copying is bounded, owned and UTF-8 safe. */
    char output[8]; int truncated = 0;
    JSAtom atom = JS_NewAtom(ctx, "abcdefghi");
    assert(qjs_guest_sampling_atom(rt, atom, output, sizeof(output), &truncated) == 7);
    assert(truncated && !strcmp(output, "abcdefg")); JS_FreeAtom(ctx, atom);
    atom = JS_NewAtom(ctx, "\xe6\xb0\xb4\xf0\x9f\x98\x80!"); truncated = 0;
    assert(qjs_guest_sampling_atom(rt, atom, output, sizeof(output), &truncated) == 7);
    assert(truncated && !strcmp(output, "\xe6\xb0\xb4\xf0\x9f\x98\x80")); JS_FreeAtom(ctx, atom);
    QJS_GuestSamplingReset(rt, 1); sample_increment = 20;
#endif
    interruptions = 0; JS_SetInterruptHandler(rt, interrupt_after_three, NULL);
    const char *loop = "for(let i=0;i<6000000;i++){}";
    JSValue result = JS_Eval(ctx, loop, strlen(loop), "cancel.js", JS_EVAL_TYPE_GLOBAL);
    assert(JS_IsException(result) && interruptions == 3);
    JS_FreeValue(ctx, JS_GetException(ctx)); JS_SetInterruptHandler(rt, NULL, NULL);
#ifdef QJS_GUEST_SAMPLING
    /* The cancelled poll must not emit a sample. */
    assert(QJS_GuestSamplingCount(rt) <= 2);
    QJS_GuestSamplingReset(rt, 1); finite(ctx);
    JS_FreeContext(ctx); ctx = NULL; JS_RunGC(rt);
    assert(!strcmp(QJS_GuestSamplingText(rt, 0, 0), "busy"));
    printf("sampling ok, storage=%zu\n", sizeof(QJSGuestSampling));
#else
    puts("disabled baseline ok");
#endif
    if(ctx) JS_FreeContext(ctx);
    JS_FreeContext(peer_ctx); JS_FreeRuntime(peer); JS_FreeRuntime(rt);
    return 0;
}
