/* Compiler diagnostic only. No Wasm3, QuickJS, or guest input is involved.
   On AArch64 preserve_none allows the callee to clobber x19. A caller with
   a dynamic stack allocation must not keep its frame base there across it. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#if !defined(__aarch64__) || !__has_attribute(preserve_none)
int main(void) { puts("unsupported compiler or architecture"); return 77; }
#else
#ifndef USE_PRESERVE_NONE
#define USE_PRESERVE_NONE 1
#endif
#if USE_PRESERVE_NONE
#define CALL __attribute__((preserve_none))
#else
#define CALL
#endif
typedef const void *Result;
typedef Result (CALL *Op)(void **, uint64_t *, void *, uint64_t, double);
static Result CALL stop(void **pc, uint64_t *sp, void *mem, uint64_t r, double f) {
    return NULL;
}
static Result CALL store(void **pc, uint64_t *sp, void *mem, uint64_t r, double f) {
    *sp = 42;
    __asm__ volatile("mov x19, %0" : : "r" (sp) : "x19");
    __attribute__((musttail)) return ((Op)*pc)(pc+1, sp, mem, r, f);
}
static inline Result CALL run(void **pc, uint64_t *sp, void *mem, uint64_t r, double f) {
    __attribute__((musttail)) return ((Op)*pc)(pc+1, sp, mem, r, f);
}
__attribute__((noinline)) static uint64_t evaluate(uint64_t *stack, void **pc, unsigned length) {
    volatile unsigned char *frame = __builtin_alloca(length);
    frame[0] = 17;
    __asm__ volatile("" : : "r" (frame) : "memory");
    Result r = run(pc, stack, NULL, 0, 0.);
    if (!r) return *stack + frame[0] - 17;
    return 0;
}
int main(int argc, char **argv) {
    uint64_t *stack = calloc(1, sizeof(*stack));
    if (!stack) return 2;
    void *code[] = {(void *)store, (void *)stop};
    uint64_t answer = evaluate(stack, code, argc + 96);
    printf("%llu\n", (unsigned long long)answer);
    free(stack);
    return answer != 42;
}
#endif
