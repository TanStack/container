/* Normal module registry bridge. This does not run the pending-job queue. */
static int qjs_require_facade_init(JSContext *ctx, JSModuleDef *module) {
    return JS_SetModuleExport(ctx, module, "__esModule", JS_TRUE);
}

static JSValue qjs_require_namespace(JSContext *ctx, JSModuleDef *root) {
    if (!JS_IsUndefined(root->require_ns)) return JS_DupValue(ctx, root->require_ns);
    JSValue namespace = JS_GetModuleNamespace(ctx, root);
    if (JS_IsException(namespace)) return namespace;
    JSAtom default_name = JS_NewAtom(ctx, "default");
    JSAtom marker_name = JS_NewAtom(ctx, "__esModule");
    JSAtom override_name = JS_NewAtom(ctx, "module.exports");
    if (!default_name || !marker_name || !override_name) {
        JS_FreeAtom(ctx, default_name);JS_FreeAtom(ctx, marker_name);JS_FreeAtom(ctx, override_name);
        JS_FreeValue(ctx, namespace);return JS_EXCEPTION;
    }
    int has_default = JS_HasProperty(ctx, namespace, default_name);
    int has_marker = JS_HasProperty(ctx, namespace, marker_name);
    int has_override = JS_HasProperty(ctx, namespace, override_name);
    JS_FreeAtom(ctx, default_name);JS_FreeAtom(ctx, marker_name);JS_FreeAtom(ctx, override_name);
    if (has_default < 0 || has_marker < 0 || has_override < 0) { JS_FreeValue(ctx, namespace); return JS_EXCEPTION; }
    if (!has_default || has_marker || has_override) return namespace;
    /* A real module facade reexports the original variable references. */
    JSModuleDef *facade = JS_NewCModule(ctx, "qjs-internal:require-facade", qjs_require_facade_init);
    if (!facade) { JS_FreeValue(ctx, namespace); return JS_EXCEPTION; }
    int dependency = add_req_module_entry(ctx, facade, root->module_name);
    if (dependency < 0) goto fail;
    facade->req_module_entries[dependency].module = root;
    facade->resolved = TRUE;
    JSPropertyEnum *properties;
    uint32_t count;
    if (JS_GetOwnPropertyNames(ctx, &properties, &count, namespace, JS_GPN_STRING_MASK) < 0) goto fail;
    int failed = 0;
    for (uint32_t i = 0; i < count; i++) {
        JSExportEntry *entry = add_export_entry2(ctx, NULL, facade, properties[i].atom, properties[i].atom, JS_EXPORT_TYPE_INDIRECT);
        if (!entry) { failed = 1; break; }
        entry->u.req_module_idx = dependency;
    }
    JS_FreePropertyEnum(ctx, properties, count);
    if (failed || JS_AddModuleExport(ctx, facade, "__esModule") < 0) goto fail;
    JSValue evaluation = JS_EvalFunction(ctx, JS_DupValue(ctx, JS_MKPTR(JS_TAG_MODULE, facade)));
    if (JS_IsException(evaluation)) goto fail;
    if (JS_PromiseState(ctx, evaluation) != JS_PROMISE_FULFILLED) {
        JSValue error = JS_PromiseResult(ctx, evaluation);
        JS_FreeValue(ctx, evaluation);
        JS_Throw(ctx, error);
        goto fail;
    }
    JS_FreeValue(ctx, evaluation);
    root->require_ns = JS_GetModuleNamespace(ctx, facade);
    if (JS_IsException(root->require_ns)) { root->require_ns = JS_UNDEFINED; goto fail; }
    JS_FreeValue(ctx, namespace);
    return JS_DupValue(ctx, root->require_ns);
fail:
    JS_FreeValue(ctx, namespace);
    return JS_EXCEPTION;
}

static JSValue qjs_require_error(JSContext *ctx, const char *code, const char *message) {
    JSValue error = JS_NewError(ctx);
    if (JS_IsException(error)) return error;
    if (JS_SetPropertyStr(ctx, error, "code", JS_NewString(ctx, code)) < 0 ||
        JS_SetPropertyStr(ctx, error, "message", JS_NewString(ctx, message)) < 0) {
        JS_FreeValue(ctx, error); return JS_EXCEPTION;
    }
    return JS_Throw(ctx, error);
}

static JSValue qjs_require_esm(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv) {
    (void)self;
    if (argc != 1) return JS_ThrowTypeError(ctx, "Expected a resolved module name");
    const char *name = JS_ToCString(ctx, argv[0]);
    if (!name) return JS_EXCEPTION;
    JSModuleDef *root = js_host_resolve_imported_module(ctx, "/", name, JS_UNDEFINED);
    JS_FreeCString(ctx, name);
    if (!root) return JS_EXCEPTION;
    if (js_resolve_module(ctx, root) < 0) return JS_EXCEPTION;
    JSModuleDef **graph = NULL;
    size_t count = 0, capacity = 0;
    JSModuleDef *next = root;
    /* Keep a local visited set, never reuse the engine's DFS evaluation state. */
    for (size_t cursor = 0;; cursor++) {
        if (count == capacity) {
            size_t grown = capacity ? capacity * 2 : 16;
            JSModuleDef **allocation = js_realloc(ctx, graph, grown * sizeof(*graph));
            if (!allocation) { js_free(ctx, graph); return JS_EXCEPTION; }
            graph = allocation; capacity = grown;
        }
        if (!count) graph[count++] = next;
        if (cursor >= count) break;
        JSModuleDef *module = graph[cursor];
        if (module->has_tla || module->status == JS_MODULE_STATUS_EVALUATING_ASYNC) {
            js_free(ctx, graph);
            return qjs_require_error(ctx, "ERR_REQUIRE_ASYNC_MODULE", "require() cannot load a module graph containing top-level await");
        }
        if (module->status == JS_MODULE_STATUS_EVALUATING) {
            js_free(ctx, graph);
            return qjs_require_error(ctx, "ERR_REQUIRE_CYCLE_MODULE", "require() cannot load an ES module while it is evaluating");
        }
        for (int i = 0; i < module->req_module_entries_count; i++) {
            next = module->req_module_entries[i].module;
            size_t j;
            for (j = 0; j < count && graph[j] != next; j++);
            if (j != count) continue;
            if (count == capacity) {
                size_t grown = capacity * 2;
                JSModuleDef **allocation = js_realloc(ctx, graph, grown * sizeof(*graph));
                if (!allocation) { js_free(ctx, graph); return JS_EXCEPTION; }
                graph = allocation; capacity = grown;
            }
            graph[count++] = next;
        }
    }
    js_free(ctx, graph);
    JSValue promise = JS_EvalFunction(ctx, JS_DupValue(ctx, JS_MKPTR(JS_TAG_MODULE, root)));
    if (JS_IsException(promise)) return promise;
    JSPromiseStateEnum state = JS_PromiseState(ctx, promise);
    if (state == JS_PROMISE_REJECTED) {
        JSValue error = JS_PromiseResult(ctx, promise);
        /* The synchronous caller consumes this rejection, without a .then job. */
        JSPromiseData *data = JS_GetOpaque(promise, JS_CLASS_PROMISE);
        if (!data->is_handled && ctx->rt->host_promise_rejection_tracker)
            ctx->rt->host_promise_rejection_tracker(ctx, promise, error, TRUE,
                ctx->rt->host_promise_rejection_tracker_opaque);
        data->is_handled = TRUE;
        JS_FreeValue(ctx, promise);
        return JS_Throw(ctx, error);
    }
    JS_FreeValue(ctx, promise);
    if (state != JS_PROMISE_FULFILLED)
        return qjs_require_error(ctx, "ERR_REQUIRE_ASYNC_MODULE", "Module evaluation did not complete synchronously");
    return qjs_require_namespace(ctx, root);
}
