#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <emscripten.h>
#include <emscripten/fiber.h>

typedef struct { uint8_t *base; size_t count; int depth; } Slot;
static emscripten_fiber_t root_fiber, child_fiber;
static uint32_t facts[19];
static unsigned requested_reentry;
static size_t requested_count;
static uint8_t marker;

EMSCRIPTEN_KEEPALIVE int probe_reenter(int input) { return input + 1; }
EM_JS(int, host_reenter, (), { return Module['_probe_reenter'](7); });

__attribute__((noinline))
static void observe(unsigned site, const void *position, const void *first,
                    size_t width, size_t count, int base_ok, int depth_ok) {
    uintptr_t p = (uintptr_t)position, b = (uintptr_t)first;
    unsigned at = site * 6;
    facts[at] = p == b;
    facts[at + 1] = p >= b && p - b == width;
    facts[at + 2] = width == sizeof(Slot);
    facts[at + 3] = count == 2;
    facts[at + 4] = base_ok;
    facts[at + 5] = depth_ok;
}

__attribute__((noinline))
static void pointer_loop(size_t count) {
    Slot stack[50], *sp = stack;
    unsigned iterations = 0;
    if (count != 1) { facts[15] = 1; return; }
    sp->base = &marker;
    sp->count = 2;
    sp->depth = 0;
    sp++;
    while (sp > stack && iterations < 1) {
        observe(0, sp, stack, sizeof(*sp), stack[0].count,
                stack[0].base == &marker, stack[0].depth == 0);
        sp--;
        observe(1, sp, stack, sizeof(*sp), stack[0].count,
                stack[0].base == &marker, stack[0].depth == 0);
        /* No unexpected pointer is dereferenced by this fixture. */
        facts[12] = sp == stack;
        iterations++;
    }
    facts[13] = iterations;
}

static void fiber_entry(void *unused) {
    (void)unused;
    facts[14] = requested_reentry ? host_reenter() == 8 : 1;
    pointer_loop(requested_count);
    emscripten_fiber_swap(&child_fiber, &root_fiber);
    abort();
}

EMSCRIPTEN_KEEPALIVE int probe_run(unsigned mode, unsigned count) {
    const size_t bytes = 512 * 1024;
    void *stack = NULL, *continuation = NULL, *root_continuation = NULL;
    for (unsigned i = 0; i < 19; i++) facts[i] = 0;
    if (mode > 2 || count != 1) return 0;
    if (!mode) { facts[14] = facts[18] = 1; pointer_loop(count); facts[16] = facts[17] = 1; return 1; }
#ifdef PROBE_ALIGNED_STACK
    stack = aligned_alloc(16, bytes);
#else
    stack = malloc(bytes);
#endif
    continuation = malloc(bytes);
    root_continuation = malloc(bytes);
    if (!stack || !continuation || !root_continuation) {
        free(stack); free(continuation); free(root_continuation); return 0;
    }
    facts[18] = ((uintptr_t)stack + bytes) % 16 == 0;
    requested_count = count;
    requested_reentry = mode == 2;
    emscripten_fiber_init(&child_fiber, fiber_entry, NULL,
                          stack, bytes, continuation, bytes);
    emscripten_fiber_init_from_current_context(&root_fiber, root_continuation, bytes);
    emscripten_fiber_swap(&root_fiber, &child_fiber);
    facts[16] = 1;
    free(stack); free(continuation); free(root_continuation);
    facts[17] = 1;
    return 1;
}

EMSCRIPTEN_KEEPALIVE uint32_t probe_fact(unsigned index) {
    return index < 19 ? facts[index] : UINT32_MAX;
}
