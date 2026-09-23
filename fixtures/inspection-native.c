#include "quickjs.c"
#include "guest-inspect.c"

static int interrupt_preview(JSRuntime *rt, void *opaque)
{
    (*(int *)opaque)++;
    return 1;
}

static int check_interruption(JSContext *ctx)
{
    const char *code = "new Map(Array.from({length:20000},(_,i)=>[i,{i}]))";
    JSValue map = JS_Eval(ctx, code, strlen(code), "inspection-interrupt.js", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(map)) return -1;
    const int checkpoints[] = {16, 128, 1024, 10000};
    for (int i = 0; i < 4; i++) {
        int calls = 0;
        ctx->interrupt_counter = checkpoints[i];
        JS_SetInterruptHandler(ctx->rt, interrupt_preview, &calls);
        JSValue result = qjs_inspect_preview_entries(ctx, JS_UNDEFINED, 1, &map);
        JS_SetInterruptHandler(ctx->rt, NULL, NULL);
        if (!JS_IsException(result) || calls != 1) return -2;
        JS_FreeValue(ctx, JS_GetException(ctx));
        JS_FreeValue(ctx, result);
        result = qjs_inspect_preview_entries(ctx, JS_UNDEFINED, 1, &map);
        if (JS_IsException(result)) return -3;
        JSValue length = JS_GetPropertyStr(ctx, result, "length");
        int32_t count;
        if (JS_ToInt32(ctx, &count, length) < 0 || count != 40000) return -4;
        JS_FreeValue(ctx, length); JS_FreeValue(ctx, result);
        JS_RunGC(ctx->rt);
    }
    JS_FreeValue(ctx, map);
    return 0;
}

static int install_inspection(JSContext *ctx)
{
    JSValue object = QJS_NewInspection(ctx), global;
    if (JS_IsException(object)) return -1;
    /* Deliberately public in this executable only, for differential fixtures. */
    global = JS_GetGlobalObject(ctx);
    int status = JS_SetPropertyStr(ctx, global, "inspection", object);
    JS_FreeValue(ctx, global);
    return status;
}

static int check_property_interruption(JSContext *ctx)
{
    const char *code = "Object.fromEntries(Array.from({length:20000},(_,i)=>['key'+i,i]))";
    JSValue object = JS_Eval(ctx, code, strlen(code), "inspection-properties-interrupt.js", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(object)) return -1;
    const int checkpoints[] = {16, 128, 1024, 10000};
    for (int i = 0; i < 4; i++) {
        int calls = 0;
        ctx->interrupt_counter = checkpoints[i];
        JS_SetInterruptHandler(ctx->rt, interrupt_preview, &calls);
        JSValue result = qjs_inspect_non_index_properties(ctx, JS_UNDEFINED, 1, &object);
        JS_SetInterruptHandler(ctx->rt, NULL, NULL);
        if (!JS_IsException(result) || calls != 1) return -2;
        JS_FreeValue(ctx, JS_GetException(ctx)); JS_FreeValue(ctx, result);
        result = qjs_inspect_non_index_properties(ctx, JS_UNDEFINED, 1, &object);
        if (JS_IsException(result)) return -3;
        JSValue length = JS_GetPropertyStr(ctx, result, "length");
        int32_t count;
        if (JS_ToInt32(ctx, &count, length) < 0 || count != 20000) return -4;
        JS_FreeValue(ctx, length); JS_FreeValue(ctx, result);
        JS_RunGC(ctx->rt);
    }
    JS_FreeValue(ctx, object);
    return 0;
}

static int install_module_namespace(JSContext *ctx)
{
    const char *source = "export const x=1";
    JSValue compiled = JS_Eval(ctx, source, strlen(source), "inspection-namespace.mjs", JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    if (JS_IsException(compiled)) return -1;
    JSModuleDef *module = JS_VALUE_GET_PTR(compiled);
    JSValue evaluated = JS_EvalFunction(ctx, compiled);
    if (JS_IsException(evaluated)) return -1;
    JS_FreeValue(ctx, evaluated);
    JSValue space = JS_GetModuleNamespace(ctx, module);
    if (JS_IsException(space)) return -1;
    JSValue global = JS_GetGlobalObject(ctx);
    int status = JS_SetPropertyStr(ctx, global, "moduleNamespace", space);
    JS_FreeValue(ctx, global);
    return status;
}

static const char *factory_verifier_source =
    "(()=>{const before=Reflect.ownKeys(globalThis).map(String).join('|');"
    "let traps=0;Object.defineProperty(Object.prototype,'types',{set(){traps++},configurable:true});"
    "return value=>{"
    "if(Reflect.ownKeys(globalThis).map(String).join('|')!==before)throw Error('factory changed globals');"
    "if(Object.getPrototypeOf(value)!==null||Object.getPrototypeOf(value.types)!==null)throw Error('factory prototype');"
    "if(Object.keys(value).length!==6||Object.keys(value.types).length!==41)throw Error('partial factory');"
    "if(!value.types.isMap(new Map())||value.types.isMap({}))throw Error('type binding');"
    "const check=(object,key,length)=>{const fn=object[key];"
    "if(typeof fn!=='function'||fn.name!==key||fn.length!==length)throw Error('partial function '+key);};"
    "for(const key of Object.keys(value.types))check(value.types,key,1);"
    "for(const [key,length] of [['getProxyDetails',2],['getPromiseDetails',1],['previewEntries',2],['getOwnNonIndexProperties',2],['getConstructorName',1]])check(value,key,length);"
    "if(value.getProxyDetails(new Proxy({x:1},{}),false).x!==1)throw Error('proxy binding');"
    "if(traps!==0)throw Error('factory invoked setter');"
    "};})()";

static int check_factory(void)
{
    int failures = 0, successes = 0;
    for (int extra = 0; extra <= 65536; extra += 256) {
        JSRuntime *rt = JS_NewRuntime();
        if (!rt) return 20;
        JSContext *ctx = JS_NewContext(rt);
        if (!ctx) return 21;
        JSValue verify = JS_Eval(ctx, factory_verifier_source, strlen(factory_verifier_source), "inspection-factory.js", JS_EVAL_TYPE_GLOBAL);
        if (JS_IsException(verify)) return 22;
        JSMemoryUsage usage;
        JS_ComputeMemoryUsage(rt, &usage);
        JS_SetMemoryLimit(rt, usage.malloc_size + extra);
        JSValue object = QJS_NewInspection(ctx);
        JS_SetMemoryLimit(rt, 32 * 1024 * 1024);
        if (JS_IsException(object)) {
            if (!JS_HasException(ctx)) return 23;
            failures++;
            JS_FreeValue(ctx, JS_GetException(ctx));
        } else {
            if (JS_HasException(ctx)) return 24;
            successes++;
            JSValue result = JS_Call(ctx, verify, JS_UNDEFINED, 1, &object);
            if (JS_IsException(result)) return 25;
            JS_FreeValue(ctx, result);
        }
        JS_FreeValue(ctx, object);
        JS_RunGC(rt);
        object = QJS_NewInspection(ctx);
        if (JS_IsException(object) || JS_HasException(ctx)) return 26;
        JSValue result = JS_Call(ctx, verify, JS_UNDEFINED, 1, &object);
        if (JS_IsException(result)) return 27;
        JS_FreeValue(ctx, result); JS_FreeValue(ctx, object);
        JS_FreeValue(ctx, verify);
        JS_FreeContext(ctx); JS_FreeRuntime(rt);
    }
    printf("{\"attempts\":257,\"allocationFailures\":%d,\"successes\":%d,\"recovered\":257,\"globalMutations\":0}\n", failures, successes);
    return !failures || !successes;
}

typedef struct {
    int enabled, count, fail_at, rejected;
} InspectionAllocator;

static int reject_inspection_allocation(JSMallocState *state)
{
    InspectionAllocator *test = state->opaque;
    if (!test->enabled) return 0;
    test->count++;
    if (test->count != test->fail_at) return 0;
    test->rejected++;
    return 1;
}

static void *inspection_malloc(JSMallocState *state, size_t size)
{
    if (reject_inspection_allocation(state)) return NULL;
    return js_def_malloc(state, size);
}

static void *inspection_realloc(JSMallocState *state, void *pointer, size_t size)
{
    if (size && reject_inspection_allocation(state)) return NULL;
    return js_def_realloc(state, pointer, size);
}

static int check_factory_allocation_sites(void)
{
    const JSMallocFunctions allocator = {
        inspection_malloc, js_def_free, inspection_realloc, js_def_malloc_usable_size
    };
    int allocation_sites = 0, failures = 0, successes = 0;
    /* Pass zero counts the successful path. Later passes fail exactly one
     * allocation from that path in a fresh runtime, without blocking cleanup. */
    for (int fail_at = 0; fail_at <= allocation_sites; fail_at++) {
        InspectionAllocator test = {0};
        JSRuntime *rt = JS_NewRuntime2(&allocator, &test);
        if (!rt) return 30;
        JSContext *ctx = JS_NewContext(rt);
        if (!ctx) return 31;
        JSValue verify = JS_Eval(ctx, factory_verifier_source, strlen(factory_verifier_source), "inspection-factory.js", JS_EVAL_TYPE_GLOBAL);
        if (JS_IsException(verify)) return 36;
        test.enabled = 1; test.fail_at = fail_at;
        JSValue object = QJS_NewInspection(ctx);
        test.enabled = 0;
        if (fail_at == 0) allocation_sites = test.count;
        if (fail_at && test.rejected != 1) return 32;
        if (JS_IsException(object)) {
            if (!JS_HasException(ctx)) return 33;
            failures++;
            JS_FreeValue(ctx, JS_GetException(ctx));
        } else {
            if (JS_HasException(ctx)) {
                fprintf(stderr, "Factory returned a value with a pending exception at allocation %d/%d\n", fail_at, allocation_sites);
                return 34;
            }
            successes++;
            JSValue result = JS_Call(ctx, verify, JS_UNDEFINED, 1, &object);
            if (JS_IsException(result)) {
                fprintf(stderr, "Invalid factory after allocation %d/%d\n", fail_at, allocation_sites);
                return 37;
            }
            JS_FreeValue(ctx, result);
        }
        JS_FreeValue(ctx, object);
        JS_RunGC(rt);
        object = QJS_NewInspection(ctx);
        if (JS_IsException(object) || JS_HasException(ctx)) return 35;
        JSValue result = JS_Call(ctx, verify, JS_UNDEFINED, 1, &object);
        if (JS_IsException(result)) return 38;
        JS_FreeValue(ctx, result);
        JS_FreeValue(ctx, object);
        JS_FreeValue(ctx, verify);
        JS_FreeContext(ctx); JS_FreeRuntime(rt);
    }
    printf("{\"allocationSites\":%d,\"attempts\":%d,\"allocationFailures\":%d,\"successes\":%d,\"recovered\":%d}\n",
           allocation_sites, allocation_sites + 1, failures, successes, allocation_sites + 1);
    return !allocation_sites || !failures || !successes;
}

int main(int argc, char **argv)
{
    if (argc != 3) return 1;
    if (strcmp(argv[2], "factory") == 0) return check_factory();
    if (strcmp(argv[2], "factory-sites") == 0) return check_factory_allocation_sites();
    FILE *file = fopen(argv[1], "rb");
    if (!file) return 2;
    fseek(file, 0, SEEK_END); long length = ftell(file); rewind(file);
    if (length < 0 || length > 4 * 1024 * 1024) return 3;
    static char source[4 * 1024 * 1024 + 1];
    if (fread(source, 1, length, file) != (size_t)length) return 4;
    fclose(file); source[length] = 0;
    int allocation = strcmp(argv[2], "allocation") == 0;
    int failures = 0, successes = 0;
    for (int extra = 0; extra <= (allocation ? 131072 : 0); extra += 512) {
        JSRuntime *rt = JS_NewRuntime();
        JSContext *ctx = JS_NewContext(rt);
        if (!ctx || install_inspection(ctx) < 0 || install_module_namespace(ctx) < 0) return 5;
        JSValue init = JS_Eval(ctx, source, length, "inspection-native.js", JS_EVAL_TYPE_GLOBAL);
        if (JS_IsException(init)) {
            JSValue error = JS_GetException(ctx);
            const char *message = JS_ToCString(ctx, error);
            fprintf(stderr, "Initialization failed: %s\n", message ? message : "unprintable error");
            JS_FreeCString(ctx, message); JS_FreeValue(ctx, error);
            return 6;
        }
        JS_FreeValue(ctx, init);
        JSValue global = JS_GetGlobalObject(ctx), run = JS_GetPropertyStr(ctx, global, "run");
        JSMemoryUsage usage;
        JS_ComputeMemoryUsage(rt, &usage);
        if (allocation) JS_SetMemoryLimit(rt, usage.malloc_size + extra);
        JSValue result = JS_Call(ctx, run, JS_UNDEFINED, 0, NULL);
        JS_SetMemoryLimit(rt, 32 * 1024 * 1024);
        if (JS_IsException(result)) {
            failures++; JS_FreeValue(ctx, JS_GetException(ctx));
            if (!allocation) return 7;
        } else successes++;
        if (!allocation) {
            const char *text = JS_ToCString(ctx, result);
            if (!text) return 8;
            puts(text); JS_FreeCString(ctx, text);
        }
        JS_FreeValue(ctx, result);
        result = JS_Call(ctx, run, JS_UNDEFINED, 0, NULL);
        if (JS_IsException(result)) return 9;
        JS_FreeValue(ctx, result);
        /* Drain reactions so retained results, not pending jobs, keep values alive. */
        JSContext *job_ctx;
        int status;
        while ((status = JS_ExecutePendingJob(rt, &job_ctx)) > 0) {}
        if (status < 0) return 10;
        JS_RunGC(rt);
        JSValue check = JS_GetPropertyStr(ctx, global, "checkRetained");
        result = JS_Call(ctx, check, JS_UNDEFINED, 0, NULL);
        if (JS_IsException(result)) return 11;
        JS_FreeValue(ctx, result); JS_FreeValue(ctx, check);
        if (!allocation && check_interruption(ctx) != 0) return 12;
        if (!allocation && check_property_interruption(ctx) != 0) return 13;
        JS_FreeValue(ctx, run); JS_FreeValue(ctx, global);
        JS_FreeContext(ctx); JS_FreeRuntime(rt);
    }
    if (allocation) printf("{\"attempts\":%d,\"allocationFailures\":%d,\"successes\":%d}\n", failures + successes, failures, successes);
    return allocation && (!failures || !successes);
}
