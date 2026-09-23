import {readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

// Unwired source diagnostics for finite Array.sort compatibility fixtures.
// QJS_SortDiagnosticGet(field) returns scalar facts, never pointer values:
// 0 phase, 1 comparator entries, 2 sort calls, 3 element count,
// 4/5 a/b valid element, 6 opaque matches caller, 7 ctx matches caller,
// 8/9 a/b element index (UINT32_MAX if invalid), 10 custom comparator,
// 11 exception flag, 12/13 a/b JS tags (UINT32_MAX if not recorded).
// 14 rqsort entries, 15 received count, 16 received element size,
// 17 base matches, 18 comparator matches, 19 opaque matches,
// 20 rqsort phase (1 entry, 2 insertion iteration, 3 before comparison),
// 21 insertion iterations, 22 comparison attempts, 23 count matches caller,
// 24 element size matches, 25/26 pi/pj valid elements, 27/28 pi/pj indexes.
// 29..77 seven boundary records: visits/count/size/countMatches/sizeMatches/
// baseMatches/stackActive. Boundaries: after swap selection, after block swap
// selection, early return, initial push, pop, before insertion, final exit.
// 78..101 four slot records: visits/count/countMatches/baseMatches/
// slotIsFirst/depthIsZero. Sites: after writes, after push observer,
// before loads, and locals after loads. No slot pointer is dereferenced by
// the recorder, the caller reads its own initialized local struct fields.
// 102..119 two noinline position records before/after decrement: visits,
// isFirst/isSecond/inRange/aligned, originalCount/countMatches/baseMatches/depthZero.
// Phases: 1 before rqsort, 2 comparator entry, 3 ctx loaded, 4 flags loaded,
// 5/6 before/after JS_Call, 7/8 before/after first ToString,
// 9/10 before/after second ToString, 11/12 before/after string comparison,
// 13 comparator return, 14 stable tie break, 15 exception, 16 rqsort returned.
// Volatile records survive a normal WASM trap. Nested sorts restore the caller's
// expected record. Instrumentation can change code layout, so a passing run is
// not by itself evidence that the underlying problem is fixed.
export function stageSortDiagnostics(directory) {
  const path = join(directory, 'quickjs.c')
  let source = readFileSync(path, 'utf8')
  const replace = (from, to) => {
    if (source.split(from).length !== 2) throw Error('Unexpected sort diagnostic site: ' + from)
    source = source.replace(from, to)
  }
  replace('static int js_array_cmp_generic(const void *a, const void *b, void *opaque) {', `typedef struct QJSSortExpected {
    const ValueSlot *base;
    size_t count;
    const void *opaque;
    JSContext *ctx;
} QJSSortExpected;
static volatile QJSSortExpected qjs_sort_expected;
static volatile uint32_t qjs_sort_diagnostic[120];
static int js_array_cmp_generic(const void *, const void *, void *);

uint32_t QJS_SortDiagnosticGet(uint32_t field)
{
    return field < 120 ? qjs_sort_diagnostic[field] : UINT32_MAX;
}

__attribute__((noinline))
void QJS_SortDiagnosticPosition(uint32_t site, const void *position,
                               const void *first, size_t element_size,
                               const void *original_base, size_t original_count,
                               int original_depth_zero)
{
    if (!qjs_sort_expected.opaque || site >= 2) return;
    uintptr_t current = (uintptr_t)position;
    uintptr_t begin = (uintptr_t)first;
    uint32_t field = 102 + site * 9;
    qjs_sort_diagnostic[field]++;
    qjs_sort_diagnostic[field + 1] = current == begin;
    qjs_sort_diagnostic[field + 2] = current >= begin && current - begin == element_size;
    qjs_sort_diagnostic[field + 3] = element_size && current >= begin &&
        (current - begin) / element_size < 50;
    qjs_sort_diagnostic[field + 4] = element_size && current >= begin &&
        (current - begin) % element_size == 0;
    qjs_sort_diagnostic[field + 5] = original_count <= UINT32_MAX ? (uint32_t)original_count : UINT32_MAX;
    qjs_sort_diagnostic[field + 6] = original_count == qjs_sort_expected.count;
    qjs_sort_diagnostic[field + 7] = original_base == qjs_sort_expected.base;
    qjs_sort_diagnostic[field + 8] = !!original_depth_zero;
}

void QJS_SortDiagnosticSlot(uint32_t site, const void *base, size_t count,
                            int slot_is_first, int depth_is_zero)
{
    if (!qjs_sort_expected.opaque || site >= 4) return;
    uint32_t field = 78 + site * 6;
    qjs_sort_diagnostic[field]++;
    qjs_sort_diagnostic[field + 1] = count <= UINT32_MAX ? (uint32_t)count : UINT32_MAX;
    qjs_sort_diagnostic[field + 2] = count == qjs_sort_expected.count;
    qjs_sort_diagnostic[field + 3] = base == qjs_sort_expected.base;
    qjs_sort_diagnostic[field + 4] = !!slot_is_first;
    qjs_sort_diagnostic[field + 5] = !!depth_is_zero;
}

void QJS_SortDiagnosticBoundary(uint32_t boundary, const void *base,
                                size_t count, size_t size, int stack_active)
{
    if (!qjs_sort_expected.opaque || boundary >= 7) return;
    uint32_t field = 29 + boundary * 7;
    qjs_sort_diagnostic[20] = 4 + boundary;
    qjs_sort_diagnostic[field]++;
    qjs_sort_diagnostic[field + 1] = count <= UINT32_MAX ? (uint32_t)count : UINT32_MAX;
    qjs_sort_diagnostic[field + 2] = size <= UINT32_MAX ? (uint32_t)size : UINT32_MAX;
    qjs_sort_diagnostic[field + 3] = count == qjs_sort_expected.count;
    qjs_sort_diagnostic[field + 4] = size == sizeof(ValueSlot);
    qjs_sort_diagnostic[field + 5] = base == qjs_sort_expected.base;
    qjs_sort_diagnostic[field + 6] = !!stack_active;
}

static uint32_t qjs_sort_element_index(const void *element)
{
    uintptr_t start = (uintptr_t)qjs_sort_expected.base;
    uintptr_t candidate = (uintptr_t)element;
    if (candidate < start) return UINT32_MAX;
    uintptr_t offset = candidate - start;
    if (offset % sizeof(ValueSlot)) return UINT32_MAX;
    uintptr_t index = offset / sizeof(ValueSlot);
    return index < qjs_sort_expected.count && index < UINT32_MAX ? (uint32_t)index : UINT32_MAX;
}

// Called by cutils only while an Array.sort caller owns the expected record.
// No memory behind supplied pointers is read here.
void QJS_SortDiagnosticRQ(uint32_t phase, const void *base, size_t count,
                          size_t size, int (*cmp)(const void *, const void *, void *),
                          void *opaque, const void *pi, const void *pj)
{
    if (!qjs_sort_expected.opaque) return;
    qjs_sort_diagnostic[20] = phase;
    if (phase == 1) {
        qjs_sort_diagnostic[14]++;
        qjs_sort_diagnostic[15] = count <= UINT32_MAX ? (uint32_t)count : UINT32_MAX;
        qjs_sort_diagnostic[16] = size <= UINT32_MAX ? (uint32_t)size : UINT32_MAX;
        qjs_sort_diagnostic[17] = base == qjs_sort_expected.base;
        qjs_sort_diagnostic[18] = cmp == js_array_cmp_generic;
        qjs_sort_diagnostic[19] = opaque == qjs_sort_expected.opaque;
        qjs_sort_diagnostic[23] = count == qjs_sort_expected.count;
        qjs_sort_diagnostic[24] = size == sizeof(ValueSlot);
    }
    if (phase == 2) qjs_sort_diagnostic[21]++;
    if (phase == 3) qjs_sort_diagnostic[22]++;
    qjs_sort_diagnostic[27] = pi ? qjs_sort_element_index(pi) : UINT32_MAX;
    qjs_sort_diagnostic[28] = pj ? qjs_sort_element_index(pj) : UINT32_MAX;
    qjs_sort_diagnostic[25] = qjs_sort_diagnostic[27] != UINT32_MAX;
    qjs_sort_diagnostic[26] = qjs_sort_diagnostic[28] != UINT32_MAX;
}

static int js_array_cmp_generic(const void *a, const void *b, void *opaque) {`)
  const start = source.indexOf('static int js_array_cmp_generic(')
  const end = source.indexOf('static JSValue js_array_sort(', start)
  if (start < 0 || end <= start) throw Error('Missing comparator diagnostic boundary')
  let comparator = source.slice(start, end)
  const cmpReplace = (from, to) => {
    if (comparator.split(from).length !== 2) throw Error('Unexpected comparator diagnostic site: ' + from)
    comparator = comparator.replace(from, to)
  }
  cmpReplace('    struct array_sort_context *psc = opaque;', `    qjs_sort_diagnostic[0] = 2;
    qjs_sort_diagnostic[1]++;
    qjs_sort_diagnostic[6] = opaque == qjs_sort_expected.opaque;
    qjs_sort_diagnostic[7] = UINT32_MAX;
    qjs_sort_diagnostic[8] = qjs_sort_element_index(a);
    qjs_sort_diagnostic[9] = qjs_sort_element_index(b);
    qjs_sort_diagnostic[4] = qjs_sort_diagnostic[8] != UINT32_MAX;
    qjs_sort_diagnostic[5] = qjs_sort_diagnostic[9] != UINT32_MAX;
    qjs_sort_diagnostic[12] = qjs_sort_diagnostic[13] = UINT32_MAX;
    struct array_sort_context *psc = opaque;`)
  cmpReplace('    JSContext *ctx = psc->ctx;', `    JSContext *ctx = psc->ctx;
    qjs_sort_diagnostic[7] = ctx == qjs_sort_expected.ctx;
    qjs_sort_diagnostic[0] = 3;`)
  cmpReplace('    if (psc->exception)', `    qjs_sort_diagnostic[10] = psc->has_method;
    qjs_sort_diagnostic[11] = psc->exception;
    if (qjs_sort_diagnostic[4]) qjs_sort_diagnostic[12] = (uint32_t)JS_VALUE_GET_TAG(ap->val);
    if (qjs_sort_diagnostic[5]) qjs_sort_diagnostic[13] = (uint32_t)JS_VALUE_GET_TAG(bp->val);
    qjs_sort_diagnostic[0] = 4;
    if (psc->exception)`)
  cmpReplace('        res = JS_Call(ctx, psc->method, JS_UNDEFINED, 2, argv);', `        qjs_sort_diagnostic[0] = 5;
        res = JS_Call(ctx, psc->method, JS_UNDEFINED, 2, argv);
        qjs_sort_diagnostic[0] = 6;`)
  for (const [element, before, after] of [['ap', 7, 8], ['bp', 9, 10]]) {
    cmpReplace(`            JSValue str = JS_ToString(ctx, ${element}->val);`, `            qjs_sort_diagnostic[0] = ${before};
            JSValue str = JS_ToString(ctx, ${element}->val);
            qjs_sort_diagnostic[0] = ${after};`)
  }
  cmpReplace('        cmp = js_string_compare(ctx, ap->str, bp->str);', `        qjs_sort_diagnostic[0] = 11;
        cmp = js_string_compare(ctx, ap->str, bp->str);
        qjs_sort_diagnostic[0] = 12;`)
  cmpReplace('    if (cmp != 0)', '    qjs_sort_diagnostic[0] = 13;\n    if (cmp != 0)')
  cmpReplace('cmp_same:\n', 'cmp_same:\n    qjs_sort_diagnostic[0] = 14;\n')
  cmpReplace('exception:\n', 'exception:\n    qjs_sort_diagnostic[0] = 15;\n')
  source = source.slice(0, start) + comparator + source.slice(end)
  replace('    rqsort(array, pos, sizeof(*array), js_array_cmp_generic, &asc);', `    QJSSortExpected previous_sort_expected = qjs_sort_expected;
    QJSSortExpected current_sort_expected = {array, pos, &asc, ctx};
    qjs_sort_expected = current_sort_expected;
    qjs_sort_diagnostic[2]++;
    qjs_sort_diagnostic[3] = pos <= UINT32_MAX ? (uint32_t)pos : UINT32_MAX;
    qjs_sort_diagnostic[0] = 1;
    rqsort(array, pos, sizeof(*array), js_array_cmp_generic, &asc);
    qjs_sort_diagnostic[0] = 16;
    qjs_sort_expected = previous_sort_expected;`)
  const utilsPath = join(directory, 'cutils.c')
  let utils = readFileSync(utilsPath, 'utf8')
  const utilsReplace = (from, to) => {
    if (utils.split(from).length !== 2) throw Error('Unexpected rqsort diagnostic site: ' + from)
    utils = utils.replace(from, to)
  }
  utilsReplace('void rqsort(void *base, size_t nmemb, size_t size, cmp_f cmp, void *opaque)\n{', `extern void QJS_SortDiagnosticRQ(uint32_t, const void *, size_t, size_t,
                                 cmp_f, void *, const void *, const void *);
extern void QJS_SortDiagnosticBoundary(uint32_t, const void *, size_t, size_t, int);
extern void QJS_SortDiagnosticSlot(uint32_t, const void *, size_t, int, int);
extern void QJS_SortDiagnosticPosition(uint32_t, const void *, const void *, size_t,
                                       const void *, size_t, int);

void rqsort(void *base, size_t nmemb, size_t size, cmp_f cmp, void *opaque)
{
    QJS_SortDiagnosticRQ(1, base, nmemb, size, cmp, opaque, NULL, NULL);`)
  utilsReplace(`    exchange_f swap = exchange_func(base, size);
    exchange_f swap_block = exchange_func(base, size | 128);

    if (nmemb < 2 || size <= 0)
        return;`, `    exchange_f swap = exchange_func(base, size);
    QJS_SortDiagnosticBoundary(0, base, nmemb, size, sp > stack);
    exchange_f swap_block = exchange_func(base, size | 128);
    QJS_SortDiagnosticBoundary(1, base, nmemb, size, sp > stack);

    if (nmemb < 2 || size <= 0) {
        QJS_SortDiagnosticBoundary(2, base, nmemb, size, sp > stack);
        return;
    }`)
  utilsReplace(`    sp->depth = 0;
    sp++;

    while (sp > stack) {`, `    sp->depth = 0;
    sp++;
    QJS_SortDiagnosticBoundary(3, base, nmemb, size, sp > stack);

    while (sp > stack) {`)
  utilsReplace(`    sp->depth = 0;
    sp++;`, `    sp->depth = 0;
    QJS_SortDiagnosticSlot(0, sp->base, sp->count, sp == stack, sp->depth == 0);
    sp++;`)
  utilsReplace(`    QJS_SortDiagnosticBoundary(3, base, nmemb, size, sp > stack);

    while (sp > stack) {`, `    QJS_SortDiagnosticBoundary(3, base, nmemb, size, sp > stack);
    QJS_SortDiagnosticSlot(1, stack[0].base, stack[0].count, sp == stack + 1, stack[0].depth == 0);

    while (sp > stack) {`)
  utilsReplace(`        sp--;
        ptr = sp->base;`, `        QJS_SortDiagnosticPosition(0, sp, stack, sizeof(*sp),
                                   stack[0].base, stack[0].count, stack[0].depth == 0);
        sp--;
        QJS_SortDiagnosticPosition(1, sp, stack, sizeof(*sp),
                                   stack[0].base, stack[0].count, stack[0].depth == 0);
        QJS_SortDiagnosticSlot(2, sp->base, sp->count, sp == stack, sp->depth == 0);
        ptr = sp->base;`)
  utilsReplace(`        depth = sp->depth;

        while (nmemb > 6) {`, `        depth = sp->depth;
        QJS_SortDiagnosticSlot(3, ptr, nmemb, sp == stack, depth == 0);
        QJS_SortDiagnosticBoundary(4, ptr, nmemb, size, sp > stack);

        while (nmemb > 6) {`)
  utilsReplace('        /* Use insertion sort for small fragments */', `        QJS_SortDiagnosticBoundary(5, ptr, nmemb, size, sp > stack);
        /* Use insertion sort for small fragments */`)
  utilsReplace(`                swap(pj, pj - size, size);
        }
    }
}`, `                swap(pj, pj - size, size);
        }
    }
    QJS_SortDiagnosticBoundary(6, base, nmemb, size, sp > stack);
}`)
  utilsReplace(`        for (pi = ptr + size, top = ptr + nmemb * size; pi < top; pi += size) {
            for (pj = pi; pj > ptr && cmp(pj - size, pj, opaque) > 0; pj -= size)`, `        for (pi = ptr + size, top = ptr + nmemb * size; pi < top; pi += size) {
            QJS_SortDiagnosticRQ(2, base, nmemb, size, cmp, opaque, pi, NULL);
            for (pj = pi; pj > ptr &&
                 (QJS_SortDiagnosticRQ(3, base, nmemb, size, cmp, opaque, pi, pj),
                  cmp(pj - size, pj, opaque)) > 0; pj -= size)`)
  // Check both translation units before writing either staged file.
  writeFileSync(path, source)
  writeFileSync(utilsPath, utils)
}
