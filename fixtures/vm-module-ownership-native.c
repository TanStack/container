#include "quickjs.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Native ownership spike. Handles are embedder-owned, never borrowed module
   pointers. No production loader or guest VM export is replaced by this test. */
#define MAX_HANDLES 32
typedef struct {
    JSContext *context;
    JSValue root;
    JSModuleDef *module;
    char id[64];
    JSValue staged;
    int linked;
} ModuleHandle;
typedef struct {ModuleHandle handles[MAX_HANDLES];unsigned count;} ModuleOwner;

static ModuleHandle *reserve(ModuleOwner *owner, JSContext *context) {
    if (owner->count == MAX_HANDLES) return NULL;
    ModuleHandle *h = &owner->handles[owner->count++];
    memset(h, 0, sizeof(*h));
    h->context = JS_DupContext(context);
    h->root = h->staged = JS_UNDEFINED;
    snprintf(h->id, sizeof(h->id), "vm-private:%u", owner->count);
    return h;
}
static ModuleHandle *compile(ModuleOwner *owner, JSContext *context, const char *source) {
    ModuleHandle *h = reserve(owner, context);
    if (!h) return NULL;
    h->root = JS_Eval(context, source, strlen(source), h->id,
                      JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY | (1 << 8));
    if (JS_IsException(h->root)) return NULL;
    h->module = JS_VALUE_GET_PTR(h->root);
    return h;
}
static int synthetic_init(JSContext *ctx, JSModuleDef *module) {
    JSValue staged = JS_GetModulePrivateValue(ctx, module);
    JSValue value = JS_GetPropertyStr(ctx, staged, "value");
    JS_FreeValue(ctx, staged);
    return JS_SetModuleExport(ctx, module, "value", value);
}
static ModuleHandle *synthetic(ModuleOwner *owner, JSContext *context, int value) {
    ModuleHandle *h = reserve(owner, context);
    if (!h) return NULL;
    h->module = JS_NewCModule(context, h->id, synthetic_init);
    if (!h->module) return NULL;
    h->root = JS_DupValue(context, JS_MKPTR(JS_TAG_MODULE, h->module));
    h->staged = JS_NewObject(context);
    if (JS_SetPropertyStr(context, h->staged, "value", JS_NewInt32(context, value)) < 0 ||
        JS_AddModuleExport(context, h->module, "value") < 0 ||
        JS_SetModulePrivateValue(context, h->module, JS_DupValue(context, h->staged)) < 0) return NULL;
    return h;
}
static JSModuleDef *load(JSContext *ctx, const char *name, void *opaque) {
    ModuleOwner *owner = opaque;
    for (unsigned i = 0; i < owner->count; i++) {
        ModuleHandle *h = &owner->handles[i];
        if (h->context == ctx && !strcmp(name, h->id)) return h->module;
    }
    JS_ThrowReferenceError(ctx, "Unknown module in this context: %s", name);
    return NULL;
}
static char *normalize(JSContext *ctx, const char *base, const char *name, void *opaque) {
    (void)base;(void)opaque;
    return js_strdup(ctx, name);
}
static int link_module(ModuleHandle *h) {
    int result = JS_ResolveModule(h->context, h->root);
    if (!result) h->linked = 1;
    return result;
}
static int evaluate(ModuleHandle *h) {
    JSValue result = JS_EvalFunction(h->context, JS_DupValue(h->context, h->root));
    if (JS_IsException(result)) return -1;
    JSContext *job;
    int count = 0, status;
    while ((status = JS_ExecutePendingJob(JS_GetRuntime(h->context), &job)) > 0)
        if (++count > 1000) {JS_FreeValue(h->context, result);return -1;}
    int failed = status < 0 || (JS_IsObject(result) && JS_PromiseState(h->context, result) == JS_PROMISE_REJECTED);
    JS_FreeValue(h->context, result);
    return failed ? -1 : 0;
}
static int read_export(ModuleHandle *h, const char *name, int expected) {
    JSValue ns = JS_GetModuleNamespace(h->context, h->module);
    JSValue value = JS_GetPropertyStr(h->context, ns, name);
    int32_t actual = 0;
    int result = JS_ToInt32(h->context, &actual, value);
    JS_FreeValue(h->context, value);JS_FreeValue(h->context, ns);
    return result < 0 || actual != expected;
}
static void close_owner(ModuleOwner *owner) {
    /* Release every root before its owning context. */
    for (unsigned i = 0; i < owner->count; i++) {
        ModuleHandle *h = &owner->handles[i];
        JS_FreeValue(h->context, h->root);JS_FreeValue(h->context, h->staged);
    }
    for (unsigned i = 0; i < owner->count; i++) JS_FreeContext(owner->handles[i].context);
}
#define CHECK(value) do {if (!(value)) {fprintf(stderr,"failed line %d\n",__LINE__);goto failed;}} while (0)
int main(void) {
    JSRuntime *rt = JS_NewRuntime();JS_SetMemoryLimit(rt,32*1024*1024);
    JSContext *ctx = JS_NewContext(rt), *other = JS_NewContext(rt);
    ModuleOwner owner = {0};JS_SetModuleLoaderFunc(rt,normalize,load,&owner);
    int result = 1;char source[256];
    ModuleHandle *dep = synthetic(&owner,ctx,17);CHECK(dep);
    snprintf(source,sizeof(source),"import {value} from '%s';export {value}",dep->id);
    ModuleHandle *survivor = compile(&owner,ctx,source);CHECK(survivor);
    ModuleHandle *bad = compile(&owner,ctx,"import 'missing'");CHECK(bad);
    CHECK(link_module(bad)<0);JS_FreeValue(ctx,JS_GetException(ctx));
    CHECK(link_module(survivor)==0);CHECK(evaluate(survivor)==0);
    CHECK(read_export(survivor,"value",17)==0);
    CHECK(JS_SetModuleExport(ctx,dep->module,"value",JS_NewInt32(ctx,24))==0);
    CHECK(read_export(survivor,"value",24)==0);
    /* A valid private ID from another context must not resolve. */
    ModuleHandle *wrong = compile(&owner,other,source);CHECK(wrong);
    CHECK(link_module(wrong)<0);JS_FreeValue(other,JS_GetException(other));
    puts("{\"independentGraphRecovery\":true,\"liveExport\":24,\"crossContextRejected\":true}");
    result=0;
failed:
    close_owner(&owner);JS_FreeContext(other);JS_FreeContext(ctx);JS_RunGC(rt);JS_FreeRuntime(rt);
    return result;
}
