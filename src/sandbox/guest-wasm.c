#include "quickjs.h"
#include "guest-wasm-fiber.h"
#ifdef QTS_SHARED_STORAGE
#include "guest-shared-storage.h"
#include <stdlib.h>
#include <math.h>
#include <limits.h>
#endif
#include "wasm3.h"
#include "m3_env.h"
#include "m3_compile.h"
#include "m3_validate.h"
#if !d_m3EnableValidation
#error "Guest WebAssembly requires eager function validation"
#endif
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <stdio.h>
#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#include <time.h>
#endif

static double module_timing_now(void) {
#ifdef __EMSCRIPTEN__
    return emscripten_get_now();
#else
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now)) return 0;
    return now.tv_sec * 1000.0 + now.tv_nsec / 1000000.0;
#endif
}

/* Host-only, opt-in measurements for one synchronous Module construction.
   These counters never call guest code or retain guest-owned pointers. */
static int module_timing_enabled;
static int module_validation_timing_active;
static double module_timing[9];
void QWasm_ModuleTimingReset(int enabled) {
    memset(module_timing, 0, sizeof(module_timing));
    module_timing_enabled = !!enabled;
    module_validation_timing_active = 0;
}
double QWasm_ModuleTimingRead(int field) {
    if (field == -1) return 9;
    return field >= 0 && field < 9 ? module_timing[field] : 0;
}
/* Called only around the unchanged validator reset. Disabled observations do
   not read the clock. Per-reset clocks add overhead and can be quantized. */
double QWasm_ValidatorResetTimingBegin(void) {
    return module_validation_timing_active ? module_timing_now() : -1;
}
void QWasm_ValidatorResetTimingEnd(double start, size_t bytes) {
    if (start < 0) return;
    module_timing[6] += module_timing_now() - start;
    module_timing[7] += 1;
    module_timing[8] += bytes;
}

/* No browser objects or host imports cross this boundary. */
extern int QJS_WasmCheckInterrupt(JSContext *ctx);
extern int QJS_WasmHasInterruptHandler(JSContext *ctx);
extern void QJS_MarkWasmBuffer(JSValueConst buffer);
static JSRuntime *allocator_runtime;
static JSContext *active_context;
static unsigned interrupt_ticks;
static int interrupted;
static JSClassID owner_class;
static JSClassID memory_class;
static JSClassID global_class;
static JSClassID table_class;
static JSValueConst bridge_helper;

#ifdef QTS_SHARED_STORAGE
M3Result qwasm_shared_resize(IM3Runtime runtime,IM3Memory memory,u64 pages) {
    if (!memory->hasMax || pages>memory->maxPages || pages<memory->numPages ||
        pages>SIZE_MAX/65536) return "shared memory limits exceeded";
    if (!memory->mallocated) {
        /* A wasm32 declared maximum can exceed this host size_t. Clamp the
         * allocation ceiling without narrowing or changing the declaration. */
        size_t maximum=memory->maxPages>SIZE_MAX/65536
            ?SIZE_MAX:(size_t)memory->maxPages*65536;
        QTSSharedStorage *storage=QTS_SharedStorageCreateWithHeaderMax((size_t)pages*65536,sizeof(M3MemoryHeader),maximum);
        if (!storage) return "shared memory group capacity exceeded";
        void *payload=QTS_SharedStorageData(storage);
        memory->sharedStorage=storage;
        memory->mallocated=QTS_SharedStorageHeader(storage);
        memory->mallocated->sharedData=payload;
        memory->mallocated->memory=memory;
    } else {
        if(!QTS_SharedStorageGrow(memory->sharedStorage,(size_t)pages*65536))
            return "shared memory group capacity exceeded";
        memory->mallocated->sharedData=QTS_SharedStorageData(memory->sharedStorage);
    }
    memory->numPages=pages;
    memory->generation++;
    memory->mallocated->length=(size_t)pages*65536;
    memory->mallocated->runtime=runtime;
    memory->mallocated->maxStack=runtime?(m3slot_t *)runtime->originStack+runtime->numStackSlots:NULL;
    return NULL;
}
void qwasm_shared_free_block(IM3Memory memory) {
    if (!memory->mallocated)return;
    QTSSharedStorage *storage=memory->sharedStorage;
    memory->mallocated=NULL;
    memory->sharedStorage=NULL;
    QTS_SharedStorageRelease(storage);
}
#endif

typedef union Allocation {
    struct { JSRuntime *runtime; size_t size; } info;
    max_align_t alignment;
} Allocation;

void *qwasm_malloc(size_t size) {
    if (!allocator_runtime || size > SIZE_MAX - sizeof(Allocation)) return NULL;
    Allocation *block = js_mallocz_rt(allocator_runtime, sizeof(Allocation) + size);
    if (!block) {
        /* Native allocations do not go through QuickJS's object-allocation GC
           trigger. Reclaim unreachable wrappers before reporting quota failure. */
        JS_RunGC(allocator_runtime);
        block = js_mallocz_rt(allocator_runtime, sizeof(Allocation) + size);
    }
    if (!block) return NULL;
    block->info.runtime = allocator_runtime; block->info.size = size;
    return block + 1;
}
void qwasm_free(void *ptr) {
    if (ptr) { Allocation *block = (Allocation *)ptr - 1; js_free_rt(block->info.runtime, block); }
}
void *qwasm_realloc(void *ptr, size_t size, size_t ignored) {
    (void)ignored;
    if (!ptr) return qwasm_malloc(size);
    if (size > SIZE_MAX - sizeof(Allocation)) return NULL;
    Allocation *block = (Allocation *)ptr - 1;
    size_t old = block->info.size;
    JSRuntime *rt = block->info.runtime;
    Allocation *original = block;
    block = js_realloc_rt(rt, original, sizeof(Allocation) + size);
    if (!block) { JS_RunGC(rt); block = js_realloc_rt(rt, original, sizeof(Allocation) + size); }
    if (!block) return NULL;
    block->info.size = size;
    if (size > old) memset((uint8_t *)(block + 1) + old, 0, size - old);
    return block + 1;
}
#ifndef QWASM_INTERRUPT_INTERVAL
#define QWASM_INTERRUPT_INTERVAL 256
#endif
int qwasm_poll(void) {
    if (active_context && (++interrupt_ticks % QWASM_INTERRUPT_INTERVAL == 0) && QJS_WasmCheckInterrupt(active_context)) interrupted = 1;
    return interrupted;
}
int qwasm_has_interrupt_budget(void) {
    return active_context && QJS_WasmHasInterruptHandler(active_context);
}

typedef struct Owner Owner;
typedef struct Memory Memory;
typedef struct Global Global;
typedef struct Table Table;
typedef struct Retired {
    struct Retired *next;
    JSValue owner;
} Retired;
static Retired **retired_roots;
typedef struct ImportBinding {
    Owner *owner;
    JSValue callback;
} ImportBinding;
typedef struct CallFrame {
    struct CallFrame *previous;
    Owner *owner;
    int failed;
    unsigned depth;
} CallFrame;
static CallFrame *active_call;
#ifdef QTS_SHARED_STORAGE
extern int QTS_FiberAtomicWait(JSContext *, void *, int, int64_t, double);
extern int QTS_FiberAtomicNotify(void *, int);
int qwasm_atomic_wait(void *ptr, int width_log2, uint64_t expected, int64_t timeout_ns) {
    if (!active_context || !active_call) return -1;
    int64_t value;
    if (width_log2 == 2) value = (int32_t)(uint32_t)expected;
    else memcpy(&value, &expected, sizeof(value));
    double timeout = timeout_ns < 0 ? INFINITY : (double)timeout_ns / 1000000.0;
    int result = QTS_FiberAtomicWait(active_context, ptr, width_log2, value, timeout);
    if (result < 0) active_call->failed = 1;
    return result;
}
int qwasm_atomic_notify(void *ptr, uint32_t count) {
    /* There can be far fewer than INT_MAX fibers. Saturating here preserves
       the unsigned WASM count without changing the JS notify interface. */
    return QTS_FiberAtomicNotify(ptr, count > INT_MAX ? INT_MAX : (int)count);
}
#endif
typedef struct Lease {
    struct Lease *next;
    Memory *memory;
    JSValue buffer; /* Weak: the buffer's finalizer removes this entry. */
    uint64_t generation;
} Lease;
struct Memory {
    JSRuntime *js;
    unsigned refs;
    IM3Memory native;
    Lease *leases;
};
/* Numeric globals own their cells independently of executable modules. Imports
   point at the same cell, so wrappers can outlive the original instance. */
struct Global {
    JSRuntime *js;
    unsigned refs;
    M3Global native;
};
struct Table {
    JSRuntime *js;
    unsigned refs;
    IM3Table native;
    JSValue *owners;
    uint32_t capacity;
};
/* Parsers retain pointers into these immutable bytes. Same-runtime instances
 * share the source, never their mutable parser, linker, or compiled state. */
typedef struct WasmSource {
    JSRuntime *js;
    size_t refs;
    uint32_t length;
    uint8_t bytes[];
} WasmSource;
struct Owner {
    JSRuntime *js;
    unsigned refs;
    int instantiated;
    int validated;
    int initialization_failed;
    WasmSource *source;
    uint8_t *bytes;
    uint32_t length;
    IM3Environment environment;
    IM3Runtime runtime;
    IM3Module module;
    Memory **memories;
    uint32_t memory_count;
    Global **globals;
    uint32_t global_count;
    ImportBinding *imports;
    uint32_t import_count;
    unsigned call_depth;
    JSValue self; /* Weak; every callable reference retains the wrapper. */
    Table **tables;
    JSValue *table_handles;
    uint32_t table_count;
    JSValue *reference_globals;
    uint32_t reference_global_count;
};
/* Trusted host FFI only. Never installed as a guest function. The caller keeps
 * value alive and copies synchronously before permitting guest execution. */
double QWasm_ModuleSourceInfo(JSContext *ctx, JSValueConst value, int field) {
    Owner *owner = JS_GetOpaque(value, owner_class);
    if (!owner || owner->js != JS_GetRuntime(ctx) || !owner->validated ||
        !owner->source || owner->source->js != owner->js || !owner->source->refs ||
        owner->bytes != owner->source->bytes || owner->length != owner->source->length)
        return -1;
    if (field == 0) return (double)owner->length;
    if (field == 1) return (double)(uintptr_t)owner->bytes;
    return -1;
}
/* A removed table/global edge may still be in an interpreter local or on its
   operand stack. Keep that owner until the outer bridge call returns. The live
   table/global edges themselves remain visible to QuickJS's cycle collector. */
static int retire_owner(JSContext *ctx, JSValueConst value) {
    if (!JS_IsObject(value) || !retired_roots) return 0;
    for (Retired *entry = *retired_roots; entry; entry = entry->next)
        if (JS_VALUE_GET_PTR(entry->owner) == JS_VALUE_GET_PTR(value)) return 0;
    Retired *entry = js_malloc(ctx, sizeof(*entry));
    if (!entry) return -1;
    entry->owner = JS_DupValue(ctx, value);
    entry->next = *retired_roots; *retired_roots = entry;
    return 0;
}
static JSValueConst function_owner(IM3Function function) {
    if (!function) return JS_UNDEFINED;
    Owner *owner = function->module->runtime->userdata;
    return owner->self;
}
static void release_table(Table *table) {
    if (!table || --table->refs) return;
    qwasm_free(table->native->elements);
    qwasm_free((void *)table->native->exportName);
    FreeImportInfo(&table->native->import);
    qwasm_free(table->native);
    qwasm_free(table->owners);
    js_free_rt(table->js, table);
}
static void finalize_table(JSRuntime *rt, JSValue value) {
    Table *table = JS_GetOpaque(value, table_class);
    if (!table) return;
    for (uint32_t i = 0; i < table->capacity; i++) {
        JS_FreeValueRT(rt, table->owners[i]); table->owners[i] = JS_UNDEFINED;
    }
    release_table(table);
}
static void mark_table(JSRuntime *rt, JSValueConst value, JS_MarkFunc *mark) {
    Table *table = JS_GetOpaque(value, table_class);
    if (table) for (uint32_t i = 0; i < table->capacity; i++) JS_MarkValue(rt, table->owners[i], mark);
}
M3Result qwasm_table_prepare(IM3Table native, uint32_t size) {
    Table *table = native->guestData;
    if (!table || size <= table->capacity) return NULL;
    if ((uint64_t)size * sizeof(JSValue) > SIZE_MAX) return "table allocation limit";
    JSValue *owners = qwasm_realloc(table->owners, (size_t)size * sizeof(JSValue), 0);
    if (!owners) return "table allocation failed";
    for (uint32_t i = table->capacity; i < size; i++) owners[i] = JS_UNDEFINED;
    table->owners = owners; table->capacity = size;
    return NULL;
}
M3Result qwasm_table_update(IM3Table native, uint32_t index, void *value) {
    Table *table = native->guestData;
    if (!table) return NULL;
    if (index >= table->capacity) return "table reference capacity exceeded";
    JSValueConst owner = function_owner(value);
    JSValue old = table->owners[index];
    if (retire_owner(active_context, old)) return "table reference retention failed";
    table->owners[index] = JS_DupValue(active_context, owner);
    JS_FreeValue(active_context, old);
    return NULL;
}
M3Result qwasm_global_update(M3Global *global, void *value) {
    Owner *owner = global->guestData;
    if (!owner) { global->refValue = value; return NULL; }
    if (global->type != c_m3Type_funcref && value) return "external WASM references are not implemented";
    uint32_t index = (uint32_t)(global - owner->module->globals);
    JSValue old = owner->reference_globals[index];
    if (retire_owner(active_context, old)) return "global reference retention failed";
    owner->reference_globals[index] = JS_DupValue(active_context, function_owner(value));
    global->refValue = value;
    JS_FreeValue(active_context, old);
    return NULL;
}
static JSValue new_table_handle(JSContext *ctx, IM3Table native) {
    JSValue value = JS_NewObjectClass(ctx, table_class);
    if (JS_IsException(value)) return value;
    Table *table = js_mallocz(ctx, sizeof(*table));
    if (!table) { JS_FreeValue(ctx, value); return JS_EXCEPTION; }
    table->js = JS_GetRuntime(ctx); table->refs = 1; table->native = native;
    native->guestData = table;
    if (qwasm_table_prepare(native, native->size)) {
        native->guestData = NULL; js_free(ctx, table); JS_FreeValue(ctx, value);
        return JS_ThrowOutOfMemory(ctx);
    }
    JS_SetOpaque(value, table);
    return value;
}
static void release_global(Global *global) {
    if (!global || --global->refs) return;
    js_free_rt(global->js, global);
}
static void finalize_global(JSRuntime *rt, JSValue value) {
    (void)rt;
    release_global(JS_GetOpaque(value, global_class));
}
static JSValue wrap_global(JSContext *ctx, Global *global) {
    JSValue value = JS_NewObjectClass(ctx, global_class);
    if (JS_IsException(value)) return value;
    global->refs++;
    JS_SetOpaque(value, global);
    return value;
}
static Global *new_global(JSContext *ctx, m3type_t type, bool mutable) {
    Global *global = js_mallocz(ctx, sizeof(*global));
    if (global) {
        global->js = JS_GetRuntime(ctx); global->refs = 1;
        global->native.type = type; global->native.isMutable = mutable;
    }
    return global;
}
static int numeric_type(m3type_t type) {
    return type >= c_m3Type_i32 && type <= c_m3Type_f64;
}
static void free_native_memory(IM3Memory memory) {
    if (!memory) return;
    FreeMemoryBlock(memory);
    qwasm_free((void *)memory->exportName);
    FreeImportInfo(&memory->import);
    qwasm_free(memory);
}
static void release_memory(Memory *memory) {
    if (!memory || --memory->refs) return;
#ifdef QTS_SHARED_STORAGE
    if (memory->native && memory->native->isShared) {
        FreeMemoryBlock(memory->native);
        free(memory->native);free(memory);return;
    }
#endif
    free_native_memory(memory->native);
    js_free_rt(memory->js, memory);
}
static void finalize_memory(JSRuntime *rt, JSValue value) {
    (void)rt;
    release_memory(JS_GetOpaque(value, memory_class));
}
static JSValue wrap_memory(JSContext *ctx, Memory *memory) {
    JSValue value = JS_NewObjectClass(ctx, memory_class);
    if (JS_IsException(value)) return value;
    memory->refs++;
    JS_SetOpaque(value, memory);
    return value;
}
#ifdef QTS_SHARED_STORAGE
/* Host-owned leases keep shared controls alive independently of any runtime.
   IDs are never reused, and only successful adoption consumes a lease. */
static struct { int id; Memory *memory; } shared_memory_leases[1024];
static uint32_t shared_memory_next_lease = 1;

JSValue QWasm_RetainSharedMemory(JSContext *ctx, JSValueConst handle) {
    Memory *memory = JS_GetOpaque2(ctx, handle, memory_class);
    if (!memory) return JS_EXCEPTION;
    if (!memory->native || !memory->native->isShared)
        return JS_ThrowTypeError(ctx, "Expected shared WASM memory");
    if (shared_memory_next_lease > INT32_MAX)
        return JS_ThrowRangeError(ctx, "Shared WASM memory lease IDs exhausted");
    for (unsigned i = 0; i < 1024; i++) {
        if (shared_memory_leases[i].memory) continue;
        int id = (int)shared_memory_next_lease++;
        memory->refs++;
        shared_memory_leases[i].id = id;
        shared_memory_leases[i].memory = memory;
        return JS_NewInt32(ctx, id);
    }
    return JS_ThrowRangeError(ctx, "Shared WASM memory lease limit exceeded");
}

JSValue QWasm_AdoptSharedMemory(JSContext *ctx, int id) {
    if (!memory_class || !JS_IsRegisteredClass(JS_GetRuntime(ctx), memory_class))
        return JS_ThrowTypeError(ctx, "WASM memory is not initialized in this runtime");
    for (unsigned i = 0; i < 1024; i++) {
        Memory *memory = shared_memory_leases[i].memory;
        if (!memory || shared_memory_leases[i].id != id) continue;
        JSValue result = wrap_memory(ctx, memory);
        if (JS_IsException(result)) return result;
        shared_memory_leases[i].memory = NULL;
        shared_memory_leases[i].id = 0;
        release_memory(memory);
        return result;
    }
    return JS_ThrowTypeError(ctx, "Unknown shared WASM memory lease");
}

int QWasm_ReleaseSharedMemory(int id) {
    for (unsigned i = 0; i < 1024; i++) {
        Memory *memory = shared_memory_leases[i].memory;
        if (!memory || shared_memory_leases[i].id != id) continue;
        shared_memory_leases[i].memory = NULL;
        shared_memory_leases[i].id = 0;
        release_memory(memory);
        return 1;
    }
    return 0;
}
#endif
/* Linear memory is shared, but the interpreter's stack and gas state are not.
   Bind headers for the active call and restore them on callback reentry. */
static void bind_owner(Owner *owner, IM3Runtime runtime) {
    if (!owner) return;
    for (uint32_t i = 0; i < owner->memory_count; i++) {
        Memory *memory = owner->memories[i];
        if (!memory || !memory->native->mallocated) continue;
        M3MemoryHeader *header = memory->native->mallocated;
        header->runtime = runtime;
        header->maxStack = runtime ? (m3slot_t *)runtime->originStack + runtime->numStackSlots : NULL;
    }
}
void QWasmFiberSave(QWasmFiberState *state) {
    state->allocator_runtime = allocator_runtime;
    state->active_context = active_context;
    state->interrupt_ticks = interrupt_ticks;
    state->interrupted = interrupted;
    state->bridge_helper = bridge_helper;
    state->active_call = active_call;
    state->retired_roots = retired_roots;
}
int QWasmFiberCanYield(void) {
    /* dispatch installs active_context before its first interrupt poll and
       retains it through parsing, compilation, execution, callbacks and cleanup.
       Nested dispatch restores the outer context rather than clearing it. */
    return active_context == NULL && active_call == NULL && allocator_runtime == NULL;
}
void QWasmFiberRestore(const QWasmFiberState *state) {
    /* A parked owner cannot leave its execution stack attached to a memory
       used by another fiber. Shared nonmoving backing storage will still need
       this rebinding: storage identity does not identify the current runtime. */
    if (active_call) bind_owner(active_call->owner, NULL);
    allocator_runtime = state->allocator_runtime;
    active_context = state->active_context;
    interrupt_ticks = state->interrupt_ticks;
    interrupted = state->interrupted;
    bridge_helper = state->bridge_helper;
    active_call = state->active_call;
    retired_roots = state->retired_roots;
    if (active_call) bind_owner(active_call->owner, active_call->owner->runtime);
}
static void leave_owner(Owner *owner) {
    bind_owner(owner, NULL);
    if (active_call) bind_owner(active_call->owner, active_call->owner->runtime);
}
static void clear_imports(Owner *owner) {
    for (uint32_t i = 0; i < owner->import_count; i++) {
        JS_FreeValueRT(owner->js, owner->imports[i].callback);
        owner->imports[i].callback = JS_UNDEFINED;
    }
}
static void release(Owner *owner) {
    if (!owner || --owner->refs) return;
    clear_imports(owner);
    js_free_rt(owner->js, owner->imports);
    leave_owner(owner);
    for (uint32_t i = 0; i < owner->table_count; i++)
        if (owner->tables[i]) owner->tables[i]->native->owner = NULL;
    if (owner->runtime) m3_FreeRuntime(owner->runtime);
    for (uint32_t i = 0; i < owner->table_count; i++) {
        release_table(owner->tables[i]);
        JS_FreeValueRT(owner->js, owner->table_handles[i]);
    }
    js_free_rt(owner->js, owner->tables); js_free_rt(owner->js, owner->table_handles);
    for (uint32_t i = 0; i < owner->reference_global_count; i++) JS_FreeValueRT(owner->js, owner->reference_globals[i]);
    js_free_rt(owner->js, owner->reference_globals);
    for (uint32_t i = 0; i < owner->memory_count; i++) release_memory(owner->memories[i]);
    js_free_rt(owner->js, owner->memories);
    for (uint32_t i = 0; i < owner->global_count; i++) release_global(owner->globals[i]);
    js_free_rt(owner->js, owner->globals);
    if (owner->environment) m3_FreeEnvironment(owner->environment);
    /* All parser/runtime teardown must finish before releasing source bytes. */
    if (owner->source && --owner->source->refs == 0)
        js_free_rt(owner->source->js, owner->source);
    js_free_rt(owner->js, owner);
}
static void finalize(JSRuntime *rt, JSValue value) {
    (void)rt;
    Owner *owner = JS_GetOpaque(value, owner_class);
    /* Buffers may retain native memory after this wrapper is collected. They
       cannot execute functions and must not retain unmarked guest callbacks. */
    if (owner) clear_imports(owner);
    release(owner);
}
static void mark_owner(JSRuntime *rt, JSValueConst value, JS_MarkFunc *mark) {
    Owner *owner = JS_GetOpaque(value, owner_class);
    if (!owner) return;
    for (uint32_t i = 0; i < owner->import_count; i++)
        JS_MarkValue(rt, owner->imports[i].callback, mark);
    for (uint32_t i = 0; i < owner->table_count; i++) JS_MarkValue(rt, owner->table_handles[i], mark);
    for (uint32_t i = 0; i < owner->reference_global_count; i++) JS_MarkValue(rt, owner->reference_globals[i], mark);
}
static void release_buffer(JSRuntime *rt, void *opaque, void *ptr) {
    /* QuickJS calls this again with NULL when a detached buffer is finalized. */
    if (!ptr) return;
    Lease *lease = opaque; Memory *memory = lease->memory;
    Lease **link = &memory->leases;
    while (*link && *link != lease) link = &(*link)->next;
    if (*link) *link = lease->next;
    js_free_rt(rt, lease); release_memory(memory);
}
static void detach_memory(JSContext *ctx, Memory *memory) {
#ifdef QTS_SHARED_STORAGE
    if (memory->native->isShared)return;
#endif
    for (Lease *lease = memory->leases, *next; lease; lease = next) {
        next = lease->next;
        if (lease->generation != memory->native->generation)
            JS_DetachArrayBuffer(ctx, lease->buffer);
    }
}
static void detach_changed(JSContext *ctx, Owner *owner) {
    for (uint32_t i = 0; i < owner->memory_count; i++)
        if (owner->memories[i]) detach_memory(ctx, owner->memories[i]);
}
static JSValue fail(JSContext *ctx, const char *kind, const char *message) {
    JSValue args[2] = {JS_NewString(ctx, kind), JS_UNDEFINED};
    if (JS_IsException(args[0])) return JS_EXCEPTION;
    args[1] = JS_NewString(ctx, message);
    JSValue error = JS_IsException(args[1]) ? JS_EXCEPTION : JS_Call(ctx, bridge_helper, JS_UNDEFINED, 2, args);
    JS_FreeValue(ctx, args[0]); JS_FreeValue(ctx, args[1]);
    if (JS_IsException(error)) return error;
    return JS_Throw(ctx, error);
}
static Owner *parse(JSContext *ctx, const uint8_t *bytes, size_t length, WasmSource *source, int timing) {
    double stage_start = timing ? module_timing_now() : 0;
    /* wasm3 takes a uint32_t length. Source copies and parser/compiler allocations
       are charged to the owning QuickJS runtime, whose host-approved budget is
       the resource limit. Do not impose a separate small-package size ceiling. */
    if (!length || length > UINT32_MAX) { fail(ctx, "CompileError", "Invalid or oversized WASM module"); return NULL; }
    if (source && (source->js != JS_GetRuntime(ctx) || source->length != length ||
                   source->bytes != bytes || source->refs == SIZE_MAX)) {
        fail(ctx, "CompileError", "Invalid WASM source ownership"); return NULL;
    }
    Owner *owner = js_mallocz(ctx, sizeof(*owner));
    if (!owner) return NULL;
    owner->js = JS_GetRuntime(ctx); owner->refs = 1; owner->length = length; owner->self = JS_UNDEFINED;
    if (source) {
        source->refs++;
        owner->source = source;
    } else {
        if (length > SIZE_MAX - sizeof(WasmSource)) {
            release(owner); JS_ThrowOutOfMemory(ctx); return NULL;
        }
        owner->source = js_malloc(ctx, sizeof(WasmSource) + length);
        if (!owner->source) { release(owner); return NULL; }
        owner->source->js = owner->js;
        owner->source->refs = 1;
        owner->source->length = length;
        memcpy(owner->source->bytes, bytes, length);
    }
    owner->bytes = owner->source->bytes;
    if (timing) {
        double now = module_timing_now();
        module_timing[0] = now - stage_start;
        module_timing[4] = length;
        stage_start = now;
    }
    owner->environment = m3_NewEnvironment();
    /* Value slots are allocator-accounted guest memory, separate from native
       dispatch frames. Compiler workloads exceed the original 64 KiB spike. */
    if (owner->environment) owner->runtime = m3_NewRuntime(owner->environment, 256 * 1024, owner);
    if (!owner->runtime) { release(owner); JS_ThrowOutOfMemory(ctx); return NULL; }
    m3_SetGasLimit(owner->runtime, 1000000);
    if (timing) {
        double now = module_timing_now();
        module_timing[1] = now - stage_start;
        stage_start = now;
    }
    M3Result error = m3_ParseModule(owner->environment, &owner->module, owner->bytes, length);
    if (timing) module_timing[2] = module_timing_now() - stage_start;
    if (error) { fail(ctx, "CompileError", error); release(owner); return NULL; }
    /* Own the parsed module before validation, without running initializers. */
    owner->module->runtime = owner->runtime;
    owner->runtime->modules = owner->module;
    return owner;
}
static int prepare_functions(JSContext *ctx, Owner *owner, int compile) {
    for (uint32_t i = owner->module->numFuncImports; i < owner->module->numFunctions; i++) {
        if (QJS_WasmCheckInterrupt(ctx)) return -1;
        M3Result error = compile ? CompileFunction(&owner->module->functions[i])
                                : ValidateFunction(&owner->module->functions[i]);
        if (error) {
            char message[512];
            /* Use only diagnostics owned by this validation pass, never stale
               compiler state or a location from another function. */
            size_t offset=0;u32 opcode=0,subopcode=0;
            if(!compile&&GetValidationLocation(&owner->module->functions[i],&offset,&opcode)) {
                if(GetValidationSubopcode(&owner->module->functions[i],&subopcode))
                    snprintf(message,sizeof(message),"%s (function %u, body offset %zu, opcode 0x%x, subopcode 0x%x)",error,i,offset,opcode,subopcode);
                else snprintf(message,sizeof(message),"%s (function %u, body offset %zu, opcode 0x%x)",error,i,offset,opcode);
            }
            else snprintf(message, sizeof(message), "%s (function %u)", error, i);
            fail(ctx, "CompileError", message); return -1;
        }
    }
    return 0;
}
static JSValue wrap(JSContext *ctx, Owner *owner) {
    JSValue value = JS_NewObjectClass(ctx, owner_class);
    if (JS_IsException(value)) { release(owner); return value; }
    JS_SetOpaque(value, owner); owner->self = value; return value;
}
static uint32_t leb(const uint8_t **p) {
    uint32_t value = 0, shift = 0; uint8_t byte;
    do { byte = *(*p)++; value |= (uint32_t)(byte & 127) << shift; shift += 7; } while (byte & 128);
    return value;
}
/* Called only on a module that the native parser and compiler validated. */
static JSValue descriptions(JSContext *ctx, Owner *owner) {
    JSValue array = JS_NewArray(ctx); uint32_t row = 0;
    if (JS_IsException(array)) return array;
    const uint8_t *p = owner->bytes + 8, *end = owner->bytes + owner->length;
    while (p < end) {
        uint8_t section = *p++; uint32_t size = leb(&p); const uint8_t *next = p + size;
        if (section == 7) {
            uint32_t count = leb(&p);
            for (uint32_t i = 0; i < count; i++) {
                uint32_t length = leb(&p); const uint8_t *name = p; p += length;
                uint8_t kind = *p++; uint32_t index = leb(&p);
                JSValue entry = JS_NewObject(ctx);
                if (JS_IsException(entry)) goto failed;
                JSValue text = JS_NewStringLen(ctx, (const char *)name, length);
                if (JS_IsException(text)) { JS_FreeValue(ctx, entry); goto failed; }
                if (JS_DefinePropertyValueStr(ctx, entry, "name", text, JS_PROP_C_W_E) < 0 ||
                    JS_DefinePropertyValueStr(ctx, entry, "kind", JS_NewUint32(ctx, kind), JS_PROP_C_W_E) < 0 ||
                    JS_DefinePropertyValueStr(ctx, entry, "index", JS_NewUint32(ctx, index), JS_PROP_C_W_E) < 0) {
                    JS_FreeValue(ctx, entry); goto failed;
                }
                if (JS_DefinePropertyValueUint32(ctx, array, row++, entry, JS_PROP_C_W_E) < 0) goto failed;
            }
        }
        p = next;
    }
    return array;
failed:
    JS_FreeValue(ctx, array); return JS_EXCEPTION;
}
static int supported_imports(Owner *owner) {
    IM3Module m = owner->module;
    for (uint32_t i = 0; i < m->numGlobals; i++) if (m->globals[i].imported && !numeric_type(m->globals[i].type)) return 0;
    for (uint32_t i = 0; i < m->numTables; i++)
        if (m->tables[i]->type != c_m3Type_funcref || m->tables[i]->isTable64) return 0;
    for (uint32_t i = 0; i < m->numMemories; i++)
        if (m->memories[i]->imported && (m->memories[i]->isMemory64 || Memory_PageSize(m->memories[i]) != 65536)) return 0;
    return 1;
}
static JSValue import_descriptions(JSContext *ctx, Owner *owner) {
    if (!supported_imports(owner)) return fail(ctx, "LinkError", "Only function, numeric global and wasm32 memory imports are supported");
    JSValue array = JS_NewArray(ctx);
    if (JS_IsException(array)) return array;
    const uint8_t *p = owner->bytes + 8, *end = owner->bytes + owner->length;
    while (p < end) {
        uint8_t section = *p++; uint32_t size = leb(&p); const uint8_t *next = p + size;
        if (section == 2) {
            uint32_t count = leb(&p);
            for (uint32_t i = 0; i < count; i++) {
                uint32_t module_length = leb(&p); const uint8_t *module = p; p += module_length;
                uint32_t name_length = leb(&p); const uint8_t *name = p; p += name_length;
                uint8_t kind = *p++, global_type = 0, mutable = 0;
                if (kind == 0) leb(&p);
                else if (kind == 1) {
                    p++; uint32_t flags = leb(&p); leb(&p); if (flags & 1) leb(&p);
                } else if (kind == 2) {
                    uint32_t flags = leb(&p); leb(&p);
                    if (flags & 1) leb(&p);
                    if (flags & 8) leb(&p);
                } else if (kind == 3) {
                    global_type = 0x80 - *p++; mutable = *p++;
                } else { fail(ctx, "LinkError", "Unsupported WASM import kind"); goto failed; }
                JSValue entry = JS_NewObject(ctx);
                if (JS_IsException(entry)) goto failed;
                JSValue module_name = JS_NewStringLen(ctx, (const char *)module, module_length);
                if (JS_IsException(module_name)) { JS_FreeValue(ctx, entry); goto failed; }
                if (JS_DefinePropertyValueStr(ctx, entry, "module", module_name, JS_PROP_C_W_E) < 0) { JS_FreeValue(ctx, entry); goto failed; }
                JSValue field_name = JS_NewStringLen(ctx, (const char *)name, name_length);
                if (JS_IsException(field_name)) { JS_FreeValue(ctx, entry); goto failed; }
                if (JS_DefinePropertyValueStr(ctx, entry, "name", field_name, JS_PROP_C_W_E) < 0 ||
                    JS_DefinePropertyValueStr(ctx, entry, "kind", JS_NewInt32(ctx, kind), JS_PROP_C_W_E) < 0 ||
                    (kind == 3 && (JS_DefinePropertyValueStr(ctx, entry, "type", JS_NewInt32(ctx, global_type), JS_PROP_C_W_E) < 0 ||
                                  JS_DefinePropertyValueStr(ctx, entry, "mutable", JS_NewBool(ctx, mutable), JS_PROP_C_W_E) < 0))) {
                    JS_FreeValue(ctx, entry); goto failed;
                }
                if (JS_DefinePropertyValueUint32(ctx, array, i, entry, JS_PROP_C_W_E) < 0) goto failed;
            }
        }
        p = next;
    }
    return array;
failed:
    JS_FreeValue(ctx, array); return JS_EXCEPTION;
}
typedef union Number { int32_t i32; int64_t i64; float f32; double f64; } Number;
/* Internal vectors cannot cross the JavaScript function boundary. Check the
   whole signature before conversions, callbacks or scalar-sized stack access. */
static int reject_js_vector_signature(JSContext *ctx, IM3Function fn) {
    for (uint32_t i = 0; i < m3_GetArgCount(fn); i++) {
        if (m3_GetArgType(fn, i) == c_m3Type_v128) {
            JS_ThrowTypeError(ctx, "WASM v128 values cannot cross the JavaScript boundary");
            return -1;
        }
    }
    for (uint32_t i = 0; i < m3_GetRetCount(fn); i++) {
        if (m3_GetRetType(fn, i) == c_m3Type_v128) {
            JS_ThrowTypeError(ctx, "WASM v128 values cannot cross the JavaScript boundary");
            return -1;
        }
    }
    return 0;
}
static JSValue number_to_js(JSContext *ctx, M3ValueType type, const void *slot) {
    Number number = {0};
    switch (type) {
        case c_m3Type_i32: memcpy(&number.i32, slot, 4); return JS_NewInt32(ctx, number.i32);
        case c_m3Type_i64: memcpy(&number.i64, slot, 8); return JS_NewBigInt64(ctx, number.i64);
        case c_m3Type_f32: memcpy(&number.f32, slot, 4); return JS_NewFloat64(ctx, number.f32);
        case c_m3Type_f64: memcpy(&number.f64, slot, 8); return JS_NewFloat64(ctx, number.f64);
        default: return JS_ThrowTypeError(ctx, "WASM reference values are not implemented yet");
    }
}
static int number_from_js(JSContext *ctx, M3ValueType type, JSValueConst value, void *slot) {
    Number number = {0}; double floating; int status;
    switch (type) {
        case c_m3Type_i32: status = JS_ToInt32(ctx, &number.i32, value); break;
        case c_m3Type_i64: status = JS_ToBigInt64(ctx, &number.i64, value); break;
        case c_m3Type_f32: status = JS_ToFloat64(ctx, &floating, value); if (!status) number.f32 = floating; break;
        case c_m3Type_f64: status = JS_ToFloat64(ctx, &number.f64, value); break;
        default: JS_ThrowTypeError(ctx, "WASM reference values are not implemented yet"); return -1;
    }
    if (!status) memcpy(slot, &number, 8);
    return status;
}
static const void *call_import(IM3Runtime runtime, IM3ImportContext import, uint64_t *sp, void *memory) {
    (void)runtime; (void)memory;
    ImportBinding *binding = import->userdata;
    JSContext *ctx = active_context;
    IM3Function fn = import->function;
    uint32_t nargs = m3_GetArgCount(fn), nrets = m3_GetRetCount(fn);
    JSValue args[16], result = JS_UNDEFINED, values = JS_UNDEFINED;
    Number results[16] = {{0}};
    uint32_t initialized = 0;
    detach_changed(ctx, binding->owner);
    if (QJS_WasmCheckInterrupt(ctx)) goto failed;
    if (reject_js_vector_signature(ctx, fn)) goto failed;
    if (nargs > 16 || nrets > 16) { fail(ctx, "RuntimeError", "WASM signature exceeds spike limit"); goto failed; }
    for (uint32_t i = 0; i < nargs; i++) {
        args[i] = number_to_js(ctx, m3_GetArgType(fn, i), sp + nrets + i);
        if (JS_IsException(args[i])) goto failed;
        initialized++;
    }
    result = JS_Call(ctx, binding->callback, JS_UNDEFINED, nargs, args);
    if (JS_IsException(result)) goto failed;
    if (nrets > 1) {
        JSValue tag = JS_NewString(ctx, "results");
        if (JS_IsException(tag)) goto failed;
        JSValue params[2] = {tag, result};
        values = JS_Call(ctx, bridge_helper, JS_UNDEFINED, 2, params);
        JS_FreeValue(ctx, tag);
        if (JS_IsException(values)) goto failed;
        JSValue length_value = JS_GetPropertyStr(ctx, values, "length"); uint32_t length;
        int status = JS_ToUint32(ctx, &length, length_value); JS_FreeValue(ctx, length_value);
        if (status) goto failed;
        if (length != nrets) { JS_ThrowTypeError(ctx, "Incorrect WASM result count"); goto failed; }
    }
    for (uint32_t i = 0; i < nrets; i++) {
        JSValue value = nrets == 1 ? JS_DupValue(ctx, result) : JS_GetPropertyUint32(ctx, values, i);
        int status = JS_IsException(value) ? -1 : number_from_js(ctx, m3_GetRetType(fn, i), value, &results[i]);
        JS_FreeValue(ctx, value);
        if (status) goto failed;
    }
    /* Result conversions may themselves reenter WASM. Publish only after all
       conversions finish, so a nested call cannot overwrite earlier results. */
    for (uint32_t i = 0; i < nrets; i++) memcpy(sp + i, &results[i], 8);
    JS_FreeValue(ctx, result); JS_FreeValue(ctx, values);
    for (uint32_t i = 0; i < initialized; i++) JS_FreeValue(ctx, args[i]);
    if (QJS_WasmCheckInterrupt(ctx)) { active_call->failed = 1; return "guest callback interrupted"; }
    return NULL;
failed:
    JS_FreeValue(ctx, result); JS_FreeValue(ctx, values);
    for (uint32_t i = 0; i < initialized; i++) JS_FreeValue(ctx, args[i]);
    active_call->failed = 1;
    return "guest callback threw";
}
static int link_callbacks(JSContext *ctx, Owner *owner, JSValueConst callbacks) {
    uint32_t count = owner->module->numFuncImports;
    if (!count) return 0;
    owner->imports = js_mallocz(ctx, count * sizeof(*owner->imports));
    if (!owner->imports) return -1;
    for (uint32_t i = 0; i < count; i++) {
        JSValue callback = JS_GetPropertyUint32(ctx, callbacks, i);
        if (JS_IsException(callback)) return -1;
        if (!JS_IsFunction(ctx, callback)) { JS_FreeValue(ctx, callback); fail(ctx, "LinkError", "WASM function import must be callable"); return -1; }
        owner->imports[i].owner = owner; owner->imports[i].callback = callback; owner->import_count++;
    }
    return 0;
}
static int compile_callbacks(JSContext *ctx, Owner *owner) {
    for (uint32_t i = 0; i < owner->import_count; i++) {
        M3Result error = CompileRawFunction(owner->module, &owner->module->functions[i], call_import, &owner->imports[i]);
        if (error) { fail(ctx, "LinkError", error); return -1; }
    }
    return 0;
}
static int link_memories(JSContext *ctx, Owner *owner, JSValueConst imports) {
    uint32_t count = owner->module->numMemories, imported = 0;
    if (!count) return 0;
    owner->memories = js_mallocz(ctx, count * sizeof(*owner->memories));
    if (!owner->memories) return -1;
    owner->memory_count = count;
    for (uint32_t i = 0; i < count; i++) {
        IM3Memory declared = owner->module->memories[i];
        if (!declared->imported) continue;
        JSValue handle = JS_GetPropertyUint32(ctx, imports, imported++);
        if (JS_IsException(handle)) return -1;
        Memory *memory = JS_GetOpaque(handle, memory_class);
        if (!memory) {
            JS_FreeValue(ctx, handle);
            fail(ctx, "LinkError", "WASM memory import must be a WebAssembly.Memory"); return -1;
        }
        IM3Memory supplied = memory->native;
        int matches = !supplied->isMemory64 && Memory_PageSize(supplied) == Memory_PageSize(declared) &&
            supplied->numPages >= declared->initPages &&
            (!declared->hasMax || (supplied->hasMax && supplied->maxPages <= declared->maxPages));
#ifdef QTS_SHARED_STORAGE
        matches=matches && supplied->isShared==declared->isShared;
#endif
        if (!matches) {
            JS_FreeValue(ctx, handle);
            fail(ctx, "LinkError", "WASM memory import limits do not match"); return -1;
        }
        memory->refs++;
        owner->memories[i] = memory;
        owner->module->memories[i] = supplied;
        free_native_memory(declared);
        JS_FreeValue(ctx, handle);
    }
    return 0;
}
static int adopt_memories(JSContext *ctx, Owner *owner) {
    for (uint32_t i = 0; i < owner->memory_count; i++) {
        if (owner->memories[i]) continue;
        IM3Memory native = owner->module->memories[i];
        if (native->isMemory64 || Memory_PageSize(native) != 65536) {
            fail(ctx, "LinkError", "Only wasm32 memories with 64 KiB pages are supported"); return -1;
        }
        Memory *memory = js_mallocz(ctx, sizeof(*memory));
        if (!memory) return -1;
        memory->js = owner->js; memory->refs = 1; memory->native = native;
        owner->memories[i] = memory;
        /* The bridge now owns this allocation. Modules borrow its pointer. */
        native->owner = NULL;
    }
    return 0;
}
static int link_globals(JSContext *ctx, Owner *owner, JSValueConst imports) {
    uint32_t count = owner->module->numGlobals, imported = 0;
    if (!count) return 0;
    owner->globals = js_mallocz(ctx, count * sizeof(*owner->globals));
    if (!owner->globals) return -1;
    owner->global_count = count;
    owner->reference_globals = js_malloc(ctx, count * sizeof(JSValue));
    if (!owner->reference_globals) return -1;
    for (uint32_t i = 0; i < count; i++) {
        owner->reference_globals[i] = JS_UNDEFINED;
        owner->module->globals[i].guestData = owner;
    }
    owner->reference_global_count = count;
    for (uint32_t i = 0; i < count; i++) {
        IM3Global declared = &owner->module->globals[i];
        if (!declared->imported) continue;
        JSValue handle = JS_GetPropertyUint32(ctx, imports, imported++);
        if (JS_IsException(handle)) return -1;
        Global *global = JS_GetOpaque(handle, global_class);
        if (!global || global->native.type != declared->type || global->native.isMutable != declared->isMutable) {
            JS_FreeValue(ctx, handle);
            fail(ctx, "LinkError", "WASM global import type or mutability does not match"); return -1;
        }
        global->refs++;
        owner->globals[i] = global;
        declared->resolved = &global->native;
        JS_FreeValue(ctx, handle);
    }
    return 0;
}
static int adopt_globals(JSContext *ctx, Owner *owner) {
    for (uint32_t i = 0; i < owner->global_count; i++) {
        IM3Global declared = &owner->module->globals[i];
        /* Vector globals stay internal, they are neither JS numeric globals
           nor reference globals with host ownership. */
        if (BaseTypeOf(declared->type) == c_m3Type_v128) continue;
        if (!numeric_type(declared->type)) {
            if (qwasm_global_update(declared, declared->refValue)) return -1;
            continue;
        }
        if (owner->globals[i]) continue;
        Global *global = new_global(ctx, declared->type, declared->isMutable);
        if (!global) return -1;
        memcpy(&global->native.i64Value, &declared->i64Value, sizeof(int64_t));
        owner->globals[i] = global;
        declared->resolved = &global->native;
    }
    return 0;
}
M3Result qwasm_prepare_instance(IM3Module module) {
    Owner *owner = module->runtime->userdata;
    /* Finish binding before publishing functions into imported tables. The
       default engine also compiles eagerly. The opt-in lazy engine preserves
       eager module validation and compiles defined bodies on first call. */
    if (adopt_memories(active_context, owner) || adopt_globals(active_context, owner) ||
        compile_callbacks(active_context, owner)
#ifndef QWASM_LAZY_COMPILATION
        || prepare_functions(active_context, owner, 1)
#endif
        ) {
        owner->initialization_failed = 1;
        return "WASM instance preparation failed";
    }
    owner->instantiated = 1;
    return NULL;
}
static int link_tables(JSContext *ctx, Owner *owner, JSValueConst imports) {
    uint32_t count = owner->module->numTables, imported = 0;
    if (!count) return 0;
    owner->tables = js_mallocz(ctx, count * sizeof(Table *));
    if (!owner->tables) return -1;
    owner->table_handles = js_malloc(ctx, count * sizeof(JSValue));
    if (!owner->table_handles) return -1;
    for (uint32_t i = 0; i < count; i++) owner->table_handles[i] = JS_UNDEFINED;
    owner->table_count = count;
    for (uint32_t i = 0; i < count; i++) {
        IM3Table declared = owner->module->tables[i];
        JSValue handle;
        if (declared->imported) {
            handle = JS_GetPropertyUint32(ctx, imports, imported++);
            if (JS_IsException(handle)) return -1;
            Table *table = JS_GetOpaque(handle, table_class);
            if (!table || table->native->type != declared->type || table->native->size < declared->initSize ||
                (declared->hasMax && (!table->native->hasMax || table->native->maxSize > declared->maxSize))) {
                JS_FreeValue(ctx, handle); fail(ctx, "LinkError", "WASM table import type or limits do not match"); return -1;
            }
            owner->module->tables[i] = table->native;
            qwasm_free(declared->elements); qwasm_free((void *)declared->exportName);
            FreeImportInfo(&declared->import); qwasm_free(declared);
        } else {
            handle = new_table_handle(ctx, declared);
            if (JS_IsException(handle)) return -1;
        }
        owner->table_handles[i] = handle;
        owner->tables[i] = JS_GetOpaque(handle, table_class);
        owner->tables[i]->refs++;
    }
    return 0;
}
int qwasm_function_types_equal(IM3FuncType a, IM3FuncType b) {
    return a == b || (a->numArgs == b->numArgs && a->numRets == b->numRets &&
        !memcmp(a->types, b->types, (a->numArgs + a->numRets) * sizeof(a->types[0])));
}
M3Result qwasm_call_indirect(IM3Function fn, void *stack, IM3Runtime caller) {
    Owner *owner = fn->module->runtime->userdata;
    JSContext *ctx = active_context;
    uint32_t nargs = m3_GetArgCount(fn), nrets = m3_GetRetCount(fn);
    if (!active_call || active_call->depth >= 32 || nargs > 16 || nrets > 16) return "indirect call limit exceeded";
    uint64_t *slots = stack;
    const void *args[16]; const void *outputs[16];
    for (uint32_t i = 0; i < nargs; i++) args[i] = slots + nrets + i;
    for (uint32_t i = 0; i < nrets; i++) outputs[i] = slots + i;
    void *saved_stack = caller->stack; caller->stack = stack;
    CallFrame frame = {.previous = active_call, .owner = owner, .depth = active_call->depth + 1}; active_call = &frame;
    bind_owner(owner, owner->runtime);
    if (!owner->call_depth++) m3_SetGasLimit(owner->runtime, 1000000);
    M3Result error = NULL;
#ifdef QWASM_LAZY_COMPILATION
    if (!fn->compiled) error = CompileFunction(fn);
#endif
    if (!error) error = m3_Call(fn, nargs, args);
    if (!error) error = m3_GetResults(fn, nrets, outputs);
    owner->call_depth--; active_call = frame.previous;
    if (frame.failed) active_call->failed = 1;
    caller->stack = saved_stack;
    detach_changed(ctx, owner); leave_owner(owner);
    return error;
}
static int descriptor_function(JSContext *ctx, JSValueConst descriptor, IM3Function *function) {
    *function = NULL;
    if (JS_IsNull(descriptor)) return 0;
    JSValue handle = JS_GetPropertyStr(ctx, descriptor, "owner");
    if (JS_IsException(handle)) return -1;
    Owner *owner = JS_GetOpaque(handle, owner_class);
    JSValue index_value = JS_GetPropertyStr(ctx, descriptor, "index"); uint32_t index;
    int status = JS_IsException(index_value) ? -1 : JS_ToUint32(ctx, &index, index_value);
    JS_FreeValue(ctx, handle); JS_FreeValue(ctx, index_value);
    if (status) return -1;
    if (!owner || index >= owner->module->numFunctions) {
        JS_ThrowTypeError(ctx, "Invalid WASM function reference"); return -1;
    }
    *function = &owner->module->functions[index];
    return 0;
}
static JSValue function_to_js(JSContext *ctx, IM3Function fn) {
    if (!fn) return JS_NULL;
    Owner *owner = fn->module->runtime->userdata;
    JSValue tag = JS_NewString(ctx, "function");
    if (JS_IsException(tag)) return tag;
    JSValue args[3] = {tag, owner->self, JS_NewUint32(ctx, fn - owner->module->functions)};
    JSValue result = JS_Call(ctx, bridge_helper, JS_UNDEFINED, 3, args);
    JS_FreeValue(ctx, tag);
    return result;
}
static JSValue operation(JSContext *ctx, int argc, JSValueConst *argv) {
    int32_t op;
    if (argc < 1 || JS_ToInt32(ctx, &op, argv[0])) return JS_EXCEPTION;
    if (op == 15) {
        uint32_t initial, maximum = d_m3MaxSaneTableSize;
        if (argc < 4 || JS_ToUint32(ctx, &initial, argv[1])) return JS_EXCEPTION;
        int has_max = !JS_IsUndefined(argv[2]);
        if (has_max && JS_ToUint32(ctx, &maximum, argv[2])) return JS_EXCEPTION;
        if (initial > maximum || initial > d_m3MaxSaneTableSize) return JS_ThrowRangeError(ctx, "Invalid table limits");
        IM3Table native = qwasm_malloc(sizeof(M3Table));
        if (!native) return JS_ThrowOutOfMemory(ctx);
        native->type = c_m3Type_funcref; native->initSize = native->size = initial;
        native->maxSize = maximum; native->hasMax = has_max;
        JSValue handle = new_table_handle(ctx, native);
        if (JS_IsException(handle)) { qwasm_free(native); return handle; }
        if (initial) native->elements = qwasm_malloc(initial * sizeof(void *));
        if (initial && !native->elements) { JS_FreeValue(ctx, handle); return JS_ThrowOutOfMemory(ctx); }
        IM3Function fn;
        if (descriptor_function(ctx, argv[3], &fn)) { JS_FreeValue(ctx, handle); return JS_EXCEPTION; }
        for (uint32_t i = 0; i < initial; i++) if (Table_Set(native, i, fn)) { JS_FreeValue(ctx, handle); return JS_EXCEPTION; }
        return handle;
    }
    if (op >= 16 && op <= 19) {
        Table *table = argc > 1 ? JS_GetOpaque2(ctx, argv[1], table_class) : NULL;
        if (!table) return JS_EXCEPTION;
        IM3Table native = table->native;
        if (op == 16) return JS_NewUint32(ctx, native->size);
        uint32_t index;
        if (argc < 3 || JS_ToUint32(ctx, &index, argv[2])) return JS_EXCEPTION;
        if (op == 19) {
            uint64_t size = (uint64_t)native->size + index;
            if (size > d_m3MaxSaneTableSize || (native->hasMax && size > native->maxSize)) return JS_ThrowRangeError(ctx, "Table growth exceeds maximum");
            IM3Function fn;
            if (descriptor_function(ctx, argv[3], &fn)) return JS_EXCEPTION;
            uint32_t previous = native->size;
            if (qwasm_table_prepare(native, size)) return JS_ThrowRangeError(ctx, "Table growth allocation failed");
            if (index) {
                void **elements = qwasm_realloc(native->elements, size * sizeof(void *), 0);
                if (!elements) return JS_ThrowRangeError(ctx, "Table growth allocation failed");
                native->elements = elements; native->size = size;
                for (uint32_t i = previous; i < size; i++) if (Table_Set(native, i, fn)) return JS_EXCEPTION;
            }
            return JS_NewUint32(ctx, previous);
        }
        if (index >= native->size) return JS_ThrowRangeError(ctx, "Table index out of bounds");
        if (op == 17) return function_to_js(ctx, native->elements[index]);
        IM3Function fn;
        if (descriptor_function(ctx, argv[3], &fn)) return JS_EXCEPTION;
        if (Table_Set(native, index, fn)) return JS_EXCEPTION;
        return JS_UNDEFINED;
    }
    if (op == 10) {
        int32_t type;
        if (argc < 4 || JS_ToInt32(ctx, &type, argv[1])) return JS_EXCEPTION;
        if (!numeric_type(type)) return JS_ThrowTypeError(ctx, "Only numeric WASM globals are supported");
        Number number = {0};
        if (number_from_js(ctx, type, argv[3], &number)) return JS_EXCEPTION;
        Global *global = new_global(ctx, type, JS_ToBool(ctx, argv[2]));
        if (!global) return JS_EXCEPTION;
        memcpy(&global->native.i64Value, &number, sizeof(number));
        JSValue value = wrap_global(ctx, global);
        release_global(global);
        return value;
    }
    if (op == 11 || op == 12 || op == 14) {
        Global *global = argc > 1 ? JS_GetOpaque2(ctx, argv[1], global_class) : NULL;
        if (!global) return JS_EXCEPTION;
        if (op == 11) return number_to_js(ctx, global->native.type, &global->native.i64Value);
        if (op == 14) {
            int32_t type;
            if (argc < 4 || JS_ToInt32(ctx, &type, argv[2])) return JS_EXCEPTION;
            return JS_NewBool(ctx, global->native.type == type && global->native.isMutable == JS_ToBool(ctx, argv[3]));
        }
        if (!global->native.isMutable) return JS_ThrowTypeError(ctx, "Cannot set an immutable WASM global");
        Number number = {0};
        if (number_from_js(ctx, global->native.type, argc > 2 ? argv[2] : JS_UNDEFINED, &number)) return JS_EXCEPTION;
        memcpy(&global->native.i64Value, &number, sizeof(number));
        return JS_UNDEFINED;
    }
    if (op == 8) {
        uint32_t initial, maximum = 65536;
        if (argc < 3 || JS_ToUint32(ctx, &initial, argv[1])) return JS_EXCEPTION;
        int has_max = !JS_IsUndefined(argv[2]);
        if (has_max && JS_ToUint32(ctx, &maximum, argv[2])) return JS_EXCEPTION;
        if (initial > 65536 || maximum > 65536 || initial > maximum)
            return JS_ThrowRangeError(ctx, "Invalid WASM memory limits");
#ifdef QTS_SHARED_STORAGE
        if (argc>3 && JS_ToBool(ctx,argv[3])) {
            if (!has_max)return JS_ThrowTypeError(ctx,"Shared WASM memory requires a maximum");
            Memory *memory=calloc(1,sizeof(*memory));
            if (!memory)return JS_ThrowOutOfMemory(ctx);
            memory->refs=1;memory->native=calloc(1,sizeof(M3Memory));
            if (!memory->native) {free(memory);return JS_ThrowOutOfMemory(ctx);}
            memory->native->initPages=initial;memory->native->maxPages=maximum;
            memory->native->pageSize=65536;memory->native->hasMax=1;memory->native->isShared=1;
            M3Result error=qwasm_shared_resize(NULL,memory->native,initial);
            if(error){release_memory(memory);return JS_ThrowRangeError(ctx,"%s",error);}
            JSValue result=wrap_memory(ctx,memory);release_memory(memory);return result;
        }
#else
        if (argc>3 && JS_ToBool(ctx,argv[3]))return JS_ThrowTypeError(ctx,"Shared WASM memory is not supported");
#endif
        Memory *memory = js_mallocz(ctx, sizeof(*memory));
        if (!memory) return JS_EXCEPTION;
        memory->js = JS_GetRuntime(ctx); memory->refs = 1;
        memory->native = qwasm_malloc(sizeof(M3Memory));
        if (!memory->native) { release_memory(memory); return JS_ThrowOutOfMemory(ctx); }
        memory->native->initPages = initial; memory->native->maxPages = maximum;
        memory->native->pageSize = 65536; memory->native->hasMax = has_max;
        M3Result error = ResizeMemory(NULL, memory->native, initial);
        if (error) { release_memory(memory); return JS_ThrowRangeError(ctx, "%s", error); }
        JSValue result = wrap_memory(ctx, memory);
        release_memory(memory);
        return result;
    }
    if (op == 4 || op == 5 || op == 21) {
        Memory *memory = argc > 1 ? JS_GetOpaque2(ctx, argv[1], memory_class) : NULL;
        if (!memory) return JS_EXCEPTION;
#ifdef QTS_SHARED_STORAGE
        if(op==21)return JS_NewFloat64(ctx,memory->native->isShared?(double)memory->native->generation:-1);
        if(op==4 && memory->native->isShared)
            return JS_NewArrayBuffer(ctx,QTS_SharedStorageData(memory->native->sharedStorage),memory->native->mallocated->length,NULL,NULL,1);
#else
        if(op==21)return JS_NewInt32(ctx,-1);
#endif
        detach_memory(ctx, memory);
        if (op == 4) {
            if (memory->leases) return JS_DupValue(ctx, memory->leases->buffer);
            Lease *lease = js_mallocz(ctx, sizeof(*lease));
            if (!lease) return JS_EXCEPTION;
            lease->memory = memory; lease->generation = memory->native->generation;
            memory->refs++; lease->next = memory->leases; memory->leases = lease;
            JSValue buffer = JS_NewArrayBuffer(ctx, (uint8_t *)(memory->native->mallocated + 1), memory->native->mallocated->length, release_buffer, lease, 0);
            if (JS_IsException(buffer)) { release_buffer(memory->js, lease, memory->native->mallocated + 1); return buffer; }
            QJS_MarkWasmBuffer(buffer); lease->buffer = buffer;
            return buffer;
        }
        uint32_t pages;
        if (argc < 3 || JS_ToUint32(ctx, &pages, argv[2])) return JS_EXCEPTION;
        uint64_t previous = memory->native->numPages;
        M3Result error = ResizeMemory(NULL, memory->native, previous + pages);
        detach_memory(ctx, memory);
        if (active_call) bind_owner(active_call->owner, active_call->owner->runtime);
        if (error) return JS_ThrowRangeError(ctx, "%s", error);
        return JS_NewUint32(ctx, previous);
    }
    if (op == 0) {
        int timing = module_timing_enabled;
        module_timing_enabled = 0;
        uint64_t offset, requested;
        if (argc < 4) return JS_ThrowTypeError(ctx, "Expected a BufferSource range");
        if (JS_ToIndex(ctx, &offset, argv[2]) || JS_ToIndex(ctx, &requested, argv[3])) return JS_EXCEPTION;
        size_t length; uint8_t *bytes = argc > 1 ? JS_GetArrayBuffer(ctx, &length, argv[1]) : NULL;
        if (!bytes) return JS_ThrowTypeError(ctx, "Expected an ArrayBuffer");
        if (offset > length || requested > length - offset)
            return JS_ThrowTypeError(ctx, "BufferSource range is out of bounds");
        /* parse copies this range into owned immutable storage before parsing
           or validation. No borrowed backing pointer survives this call. */
        Owner *owner = parse(ctx, bytes + (size_t)offset, (size_t)requested, NULL, timing);
        if (!owner) return JS_EXCEPTION;
        /* Validate eagerly, but emit instance-bound instructions only after
           imports are linked. Module objects never execute this code. */
        double validation_start = timing ? module_timing_now() : 0;
        module_validation_timing_active = timing;
        int validation_error = prepare_functions(ctx, owner, 0);
        module_validation_timing_active = 0;
        if (timing) module_timing[3] = module_timing_now() - validation_start;
        if (validation_error) { release(owner); return JS_EXCEPTION; }
        owner->validated = 1;
        if (timing) module_timing[5] = 1;
        return wrap(ctx, owner);
    }
    Owner *owner = argc > 1 ? JS_GetOpaque2(ctx, argv[1], owner_class) : NULL;
    if (!owner) return JS_EXCEPTION;
    if (op == 1) return descriptions(ctx, owner);
    if (op == 6) return import_descriptions(ctx, owner);
    if (op == 22) {
        if (!owner->validated) return fail(ctx, "CompileError", "Expected a validated WASM module");
        /* Serialization receives an independent copy, never a writable view of
           the immutable bytes retained by live parsers and instances. */
        return JS_NewArrayBufferCopy(ctx, owner->bytes, owner->length);
    }
    if (op == 2) {
        if (!owner->validated) return fail(ctx, "CompileError", "Expected a validated WASM module");
        if (active_call && active_call->depth >= 32) return fail(ctx, "RuntimeError", "WASM callback nesting limit exceeded");
        if (!supported_imports(owner)) return fail(ctx, "LinkError", "Only function, numeric global and wasm32 memory imports are supported");
        Owner *instance = parse(ctx, owner->bytes, owner->length, owner->source, 0);
        if (!instance) return JS_EXCEPTION;
#ifdef QTS_SHARED_STORAGE
        /* Parsed memory records belong to a runtime allocator. Until native
           defined-memory adoption gets group ownership, reject it before load. */
        for(uint32_t i=0;i<instance->module->numMemories;i++)
            if(instance->module->memories[i]->isShared && !instance->module->memories[i]->imported) {
                fail(ctx,"LinkError","Internally declared shared WASM memory is not supported");
                release(instance);return JS_EXCEPTION;
            }
#endif
        /* parse retains the validated, privately owned immutable bytes before
           any import getters run. Linking still checks import types and limits; compilation
           still emits private instance-bound instructions and checks its own
           constraints. Only the repeated body-validation pass is omitted. */
        instance->validated = 1;
        m3_SetValidation(instance->runtime, false);
        JSValue instance_handle = wrap(ctx, instance);
        if (JS_IsException(instance_handle)) return instance_handle;
        JSValue memories = JS_GetPropertyStr(ctx, argv[3], "memories");
        if (JS_IsException(memories)) { JS_FreeValue(ctx, instance_handle); return JS_EXCEPTION; }
        int failed = link_memories(ctx, instance, memories);
        JS_FreeValue(ctx, memories);
        if (failed) { JS_FreeValue(ctx, instance_handle); return JS_EXCEPTION; }
        JSValue globals = JS_GetPropertyStr(ctx, argv[3], "globals");
        if (JS_IsException(globals)) { JS_FreeValue(ctx, instance_handle); return JS_EXCEPTION; }
        failed = link_globals(ctx, instance, globals);
        JS_FreeValue(ctx, globals);
        if (failed) { JS_FreeValue(ctx, instance_handle); return JS_EXCEPTION; }
        JSValue tables = JS_GetPropertyStr(ctx, argv[3], "tables");
        if (JS_IsException(tables)) { JS_FreeValue(ctx, instance_handle); return JS_EXCEPTION; }
        failed = link_tables(ctx, instance, tables);
        JS_FreeValue(ctx, tables);
        if (failed) { JS_FreeValue(ctx, instance_handle); return JS_EXCEPTION; }
        if (link_callbacks(ctx, instance, argv[2])) { JS_FreeValue(ctx, instance_handle); return JS_EXCEPTION; }
        /* Transfer the parsed module to m3_LoadModule, which owns failed loads too. */
        instance->runtime->modules = NULL; instance->module->runtime = NULL;
        M3Result error = m3_LoadModule(instance->runtime, instance->module);
        for (uint32_t i = 0; i < instance->table_count; i++) instance->tables[i]->native->owner = NULL;
        if (instance->initialization_failed) { JS_FreeValue(ctx, instance_handle); return JS_EXCEPTION; }
        CallFrame frame = {.previous = active_call, .owner = instance, .depth = active_call ? active_call->depth + 1 : 1}; active_call = &frame;
        bind_owner(instance, instance->runtime);
        instance->call_depth++;
        if (!error) error = m3_RunStart(instance->module);
        /* JavaScript instantiation invokes start once, even when it traps.
           Functions published through imported tables must not retry it. */
        instance->module->startFunction = -1;
        instance->call_depth--; active_call = frame.previous;
        detach_changed(ctx, instance); leave_owner(instance);
        if (frame.failed || interrupted) { JS_FreeValue(ctx, instance_handle); return JS_EXCEPTION; }
        if (error) { fail(ctx, "RuntimeError", error); JS_FreeValue(ctx, instance_handle); return JS_EXCEPTION; }
        return instance_handle;
    }
    if (!owner->instantiated) return JS_ThrowTypeError(ctx, "Expected a WASM instance");
    uint32_t index;
    if (argc < 3 || JS_ToUint32(ctx, &index, argv[2])) return JS_EXCEPTION;
    if (op == 20) {
        if (index >= owner->table_count) return JS_ThrowTypeError(ctx, "Invalid WASM table");
        return JS_DupValue(ctx, owner->table_handles[index]);
    }
    if (op == 7) {
        if (index >= owner->memory_count) return JS_ThrowTypeError(ctx, "Invalid WASM memory");
        return wrap_memory(ctx, owner->memories[index]);
    }
    if (op == 9) {
        if (index >= owner->global_count || !owner->globals[index]) return JS_ThrowTypeError(ctx, "Only numeric WASM global exports are supported");
        return wrap_global(ctx, owner->globals[index]);
    }
    if (op == 3) {
        if (active_call && active_call->depth >= 32) return fail(ctx, "RuntimeError", "WASM callback nesting limit exceeded");
        if (index >= owner->module->numFunctions || argc < 4) return JS_ThrowTypeError(ctx, "Invalid WASM function");
        IM3Function fn = &owner->module->functions[index];
        if (reject_js_vector_signature(ctx, fn)) return JS_EXCEPTION;
        uint32_t nargs = m3_GetArgCount(fn), nrets = m3_GetRetCount(fn);
        if (nargs > 16 || nrets > 16) return fail(ctx, "RuntimeError", "WASM signature exceeds spike limit");
        Number args[16] = {{0}}, results[16] = {{0}}; const void *pointers[16], *outputs[16];
        for (uint32_t i = 0; i < nargs; i++) {
            JSValue arg = JS_GetPropertyUint32(ctx, argv[3], i);
            int status = JS_IsException(arg) ? -1 : number_from_js(ctx, m3_GetArgType(fn, i), arg, &args[i]);
            JS_FreeValue(ctx, arg); if (status) return JS_EXCEPTION; pointers[i] = &args[i];
        }
        for (uint32_t i = 0; i < nrets; i++) outputs[i] = &results[i];
        CallFrame frame = {.previous = active_call, .owner = owner, .depth = active_call ? active_call->depth + 1 : 1}; active_call = &frame;
        bind_owner(owner, owner->runtime);
        if (!owner->call_depth++) m3_SetGasLimit(owner->runtime, 1000000);
        M3Result error = NULL;
#ifdef QWASM_LAZY_COMPILATION
        if (!fn->compiled) error = CompileFunction(fn);
#endif
        if (!error) error = m3_Call(fn, nargs, pointers);
        owner->call_depth--; active_call = frame.previous;
        detach_changed(ctx, owner);
        leave_owner(owner);
        if (frame.failed || interrupted || QJS_WasmCheckInterrupt(ctx)) return JS_EXCEPTION;
        if (!error) error = m3_GetResults(fn, nrets, outputs);
        if (error) return fail(ctx, "RuntimeError", error);
        JSValue array = nrets > 1 ? JS_NewArray(ctx) : JS_UNDEFINED;
        if (JS_IsException(array)) return array;
        for (uint32_t i = 0; i < nrets; i++) {
            JSValue value;
            switch (m3_GetRetType(fn, i)) {
                case c_m3Type_i32: value = JS_NewInt32(ctx, results[i].i32); break;
                case c_m3Type_i64: value = JS_NewBigInt64(ctx, results[i].i64); break;
                case c_m3Type_f32: value = JS_NewFloat64(ctx, results[i].f32); break;
                case c_m3Type_f64: value = JS_NewFloat64(ctx, results[i].f64); break;
                default: JS_FreeValue(ctx, array); return JS_ThrowTypeError(ctx, "WASM reference results are unsupported");
            }
            if (nrets == 1) return value;
            if (JS_IsException(value)) { JS_FreeValue(ctx, array); return JS_EXCEPTION; }
            if (JS_DefinePropertyValueUint32(ctx, array, i, value, JS_PROP_C_W_E) < 0) { JS_FreeValue(ctx, array); return JS_EXCEPTION; }
        }
        return array;
    }
    return JS_ThrowTypeError(ctx, "Unknown WASM operation");
}
static JSValue dispatch(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv) {
    (void)self;
    JSRuntime *saved_runtime = allocator_runtime; JSContext *saved_context = active_context;
    int saved_interrupted = interrupted;
    JSValueConst saved_helper = bridge_helper;
    bridge_helper = argc > 4 ? argv[4] : JS_UNDEFINED;
    allocator_runtime = JS_GetRuntime(ctx); active_context = ctx; interrupted = 0;
    Retired *retired = NULL;
    Retired **saved_roots = retired_roots;
    if (!retired_roots) retired_roots = &retired;
    JSValue result = QJS_WasmCheckInterrupt(ctx) ? JS_EXCEPTION : operation(ctx, argc, argv);
    if (!JS_IsException(result) && QJS_WasmCheckInterrupt(ctx)) { JS_FreeValue(ctx, result); result = JS_EXCEPTION; }
    retired_roots = saved_roots;
    while (retired) {
        Retired *next = retired->next;
        JS_FreeValue(ctx, retired->owner); js_free(ctx, retired); retired = next;
    }
    allocator_runtime = saved_runtime; active_context = saved_context; interrupted = saved_interrupted;
    bridge_helper = saved_helper;
    return result;
}
int QJS_InstallWasm(JSContext *ctx) {
    if (!owner_class) JS_NewClassID(&owner_class);
    if (!memory_class) JS_NewClassID(&memory_class);
    if (!global_class) JS_NewClassID(&global_class);
    if (!table_class) JS_NewClassID(&table_class);
    JSRuntime *rt = JS_GetRuntime(ctx);
    if (!JS_IsRegisteredClass(rt, owner_class)) {
        JSClassDef definition = {.class_name = "WasmOwner", .finalizer = finalize, .gc_mark = mark_owner};
        if (JS_NewClass(rt, owner_class, &definition)) return -1;
    }
    if (!JS_IsRegisteredClass(rt, memory_class)) {
        JSClassDef definition = {.class_name = "WasmMemory", .finalizer = finalize_memory};
        if (JS_NewClass(rt, memory_class, &definition)) return -1;
    }
    if (!JS_IsRegisteredClass(rt, global_class)) {
        JSClassDef definition = {.class_name = "WasmGlobal", .finalizer = finalize_global};
        if (JS_NewClass(rt, global_class, &definition)) return -1;
    }
    if (!JS_IsRegisteredClass(rt, table_class)) {
        JSClassDef definition = {.class_name = "WasmTable", .finalizer = finalize_table, .gc_mark = mark_table};
        if (JS_NewClass(rt, table_class, &definition)) return -1;
    }
    JSValue global = JS_GetGlobalObject(ctx);
#ifdef QTS_SHARED_STORAGE
    if(JS_SetPropertyStr(ctx,global,"__nativeSharedWasmMemory",JS_TRUE)<0){JS_FreeValue(ctx,global);return -1;}
#endif
    int result = JS_SetPropertyStr(ctx, global, "__nativeWasm", JS_NewCFunction(ctx, dispatch, "nativeWasm", 4));
    JS_FreeValue(ctx, global); return result < 0 ? -1 : 0;
}
