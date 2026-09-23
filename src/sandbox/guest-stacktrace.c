/* Included inside pinned QuickJS, after its Error helpers. All retained values
 * are ordinary GC-visible references, never pointers into a suspended stack. */
typedef struct {
    JSValue function, receiver, name, file, method, type;
    int line, column;
    BOOL native, constructor, strict, toplevel, eval;
} QJSCallSite;
static JSClassID qjs_callsite_class;

static void qjs_callsite_free(JSRuntime *rt, JSValue value)
{
    QJSCallSite *site = JS_GetOpaque(value, qjs_callsite_class);
    if (!site) return;
    JS_FreeValueRT(rt, site->function);
    JS_FreeValueRT(rt, site->receiver);
    JS_FreeValueRT(rt, site->name);
    JS_FreeValueRT(rt, site->file);
    JS_FreeValueRT(rt, site->method);
    JS_FreeValueRT(rt, site->type);
    js_free_rt(rt, site);
}
static void qjs_callsite_mark(JSRuntime *rt, JSValueConst value, JS_MarkFunc *mark)
{
    QJSCallSite *site = JS_GetOpaque(value, qjs_callsite_class);
    if (!site) return;
    JS_MarkValue(rt, site->function, mark);
    JS_MarkValue(rt, site->receiver, mark);
    JS_MarkValue(rt, site->name, mark);
    JS_MarkValue(rt, site->file, mark);
    JS_MarkValue(rt, site->method, mark);
    JS_MarkValue(rt, site->type, mark);
}
static JSValue qjs_callsite_string(JSContext *ctx, QJSCallSite *site)
{
    const char *name = NULL, *file = NULL;
    DynBuf buf;
    JSValue result;
    js_dbuf_init(ctx, &buf);
    if (!JS_IsNull(site->name)) {
        name = JS_ToCString(ctx, site->name);
        if (!name) goto failed;
    }
    if (!JS_IsNull(site->file)) {
        file = JS_ToCString(ctx, site->file);
        if (!file) goto failed;
    }
    if (site->constructor) dbuf_printf(&buf, "new ");
    if (name && name[0]) dbuf_printf(&buf, "%s (", name);
    if (site->native) dbuf_printf(&buf, "native");
    else if (file) {
        dbuf_printf(&buf, "%s", file);
        if (site->line) dbuf_printf(&buf, ":%d:%d", site->line, site->column);
    } else dbuf_printf(&buf, "<anonymous>");
    if (name && name[0]) dbuf_putc(&buf, ')');
    if (dbuf_error(&buf)) { JS_ThrowOutOfMemory(ctx); goto failed; }
    result = JS_NewStringLen(ctx, (const char *)buf.buf, buf.size);
    goto done;
failed:
    result = JS_EXCEPTION;
done:
    JS_FreeCString(ctx, name); JS_FreeCString(ctx, file); dbuf_free(&buf);
    return result;
}
enum { QCS_FUNCTION, QCS_THIS, QCS_NAME, QCS_FILE, QCS_LINE, QCS_COLUMN,
       QCS_NATIVE, QCS_CONSTRUCTOR, QCS_TOPLEVEL, QCS_STRING, QCS_TYPE,
       QCS_METHOD, QCS_EVAL, QCS_EVAL_ORIGIN };
static JSValue qjs_callsite_get(JSContext *ctx, JSValueConst receiver,
                               int argc, JSValueConst *argv, int magic)
{
    QJSCallSite *site = JS_GetOpaque2(ctx, receiver, qjs_callsite_class);
    if (!site) return JS_EXCEPTION;
    switch (magic) {
    case QCS_FUNCTION: return JS_DupValue(ctx, site->function);
    case QCS_THIS: return JS_DupValue(ctx, site->receiver);
    case QCS_NAME: return JS_DupValue(ctx, site->name);
    case QCS_FILE: return JS_DupValue(ctx, site->file);
    case QCS_LINE: return site->line ? JS_NewInt32(ctx, site->line) : JS_NULL;
    case QCS_COLUMN: return site->column ? JS_NewInt32(ctx, site->column) : JS_NULL;
    case QCS_NATIVE: return JS_NewBool(ctx, site->native);
    case QCS_CONSTRUCTOR: return JS_NewBool(ctx, site->constructor);
    case QCS_TOPLEVEL: return JS_NewBool(ctx, site->toplevel);
    case QCS_STRING: return qjs_callsite_string(ctx, site);
    case QCS_TYPE: return JS_DupValue(ctx, site->type);
    case QCS_METHOD: return JS_DupValue(ctx, site->method);
    case QCS_EVAL: return JS_NewBool(ctx, site->eval);
    case QCS_EVAL_ORIGIN:
        if (!site->eval) return JS_UNDEFINED;
        return JS_ThrowInternalError(ctx, "Eval origin metadata is not implemented");
    default: return JS_UNDEFINED;
    }
}
static const JSCFunctionListEntry qjs_callsite_methods[] = {
    JS_CFUNC_MAGIC_DEF("getFunction", 0, qjs_callsite_get, QCS_FUNCTION),
    JS_CFUNC_MAGIC_DEF("getThis", 0, qjs_callsite_get, QCS_THIS),
    JS_CFUNC_MAGIC_DEF("getFunctionName", 0, qjs_callsite_get, QCS_NAME),
    JS_CFUNC_MAGIC_DEF("getFileName", 0, qjs_callsite_get, QCS_FILE),
    JS_CFUNC_MAGIC_DEF("getScriptNameOrSourceURL", 0, qjs_callsite_get, QCS_FILE),
    JS_CFUNC_MAGIC_DEF("getLineNumber", 0, qjs_callsite_get, QCS_LINE),
    JS_CFUNC_MAGIC_DEF("getColumnNumber", 0, qjs_callsite_get, QCS_COLUMN),
    JS_CFUNC_MAGIC_DEF("isNative", 0, qjs_callsite_get, QCS_NATIVE),
    JS_CFUNC_MAGIC_DEF("isConstructor", 0, qjs_callsite_get, QCS_CONSTRUCTOR),
    JS_CFUNC_MAGIC_DEF("isToplevel", 0, qjs_callsite_get, QCS_TOPLEVEL),
    JS_CFUNC_MAGIC_DEF("getTypeName", 0, qjs_callsite_get, QCS_TYPE),
    JS_CFUNC_MAGIC_DEF("getMethodName", 0, qjs_callsite_get, QCS_METHOD),
    JS_CFUNC_MAGIC_DEF("isEval", 0, qjs_callsite_get, QCS_EVAL),
    JS_CFUNC_MAGIC_DEF("getEvalOrigin", 0, qjs_callsite_get, QCS_EVAL_ORIGIN),
    JS_CFUNC_MAGIC_DEF("toString", 0, qjs_callsite_get, QCS_STRING),
};
static int qjs_callsite_init(JSContext *ctx)
{
    JSValue proto;
    JSClassDef def = { .class_name = "CallSite", .finalizer = qjs_callsite_free,
                      .gc_mark = qjs_callsite_mark };
    JS_NewClassID(&qjs_callsite_class);
    if (!JS_IsRegisteredClass(ctx->rt, qjs_callsite_class) &&
        JS_NewClass(ctx->rt, qjs_callsite_class, &def) < 0) return -1;
    proto = JS_GetClassProto(ctx, qjs_callsite_class);
    if (!JS_IsUndefined(proto) && !JS_IsNull(proto)) { JS_FreeValue(ctx, proto); return 0; }
    JS_FreeValue(ctx, proto);
    proto = JS_NewObject(ctx);
    if (JS_IsException(proto)) return -1;
    if (JS_SetPropertyFunctionList(ctx, proto, qjs_callsite_methods, countof(qjs_callsite_methods)) < 0) {
        JS_FreeValue(ctx, proto); return -1;
    }
    JS_SetClassProto(ctx, qjs_callsite_class, proto);
    return 0;
}
static JSValue qjs_capture_sites(JSContext *ctx, JSValueConst skip, uint32_t limit)
{
    JSValue array = JS_UNDEFINED, object;
    JSStackFrame *frame;
    uint32_t count = 0;
    BOOL skipping = TRUE, strict = FALSE;
    if (qjs_callsite_init(ctx) < 0) return JS_EXCEPTION;
    array = JS_NewArray(ctx);
    if (JS_IsException(array)) return array;
    for (frame = ctx->rt->current_stack_frame; frame; frame = frame->prev_frame) {
        JSObject *function;
        QJSCallSite *site;
        const char *name;
        if (js_poll_interrupts(ctx)) goto failed;
        if (frame->js_mode & JS_MODE_BACKTRACE_BARRIER) break;
        if (!JS_IsObject(frame->cur_func)) continue;
        if (skipping) {
            if (JS_IsObject(skip) && JS_VALUE_GET_OBJ(frame->cur_func) == JS_VALUE_GET_OBJ(skip)) skipping = FALSE;
            continue;
        }
        if (count >= limit) break;
        strict |= !!(frame->js_mode & JS_MODE_STRICT);
        function = JS_VALUE_GET_OBJ(frame->cur_func);
        /* V8 does not report Function.call/apply trampoline frames. */
        if (function->class_id == JS_CLASS_C_FUNCTION &&
            (function->u.cfunc.c_function.generic == js_function_call ||
             function->u.cfunc.c_function.generic_magic == js_function_apply)) continue;
        object = JS_NewObjectClass(ctx, qjs_callsite_class);
        if (JS_IsException(object)) goto failed;
        site = js_mallocz(ctx, sizeof(*site));
        if (!site) { JS_FreeValue(ctx, object); goto failed; }
        site->function = site->receiver = JS_UNDEFINED;
        site->name = site->file = site->method = site->type = JS_NULL;
        JS_SetOpaque(object, site);
        site->strict = strict;
        site->constructor = frame->capture_constructor;
        site->toplevel = JS_IsNull(frame->capture_this) || JS_IsUndefined(frame->capture_this) ||
            (JS_IsObject(frame->capture_this) && JS_VALUE_GET_OBJ(frame->capture_this) == JS_VALUE_GET_OBJ(ctx->global_obj));
        if (!strict) {
            site->function = JS_DupValue(ctx, frame->cur_func);
            site->receiver = site->toplevel ? JS_DupValue(ctx, ctx->global_obj) : JS_DupValue(ctx, frame->capture_this);
        }
        if (!site->toplevel && JS_IsObject(frame->capture_this)) {
            JSObject *owner;
            BOOL constructor_seen = FALSE;
            for (owner = JS_VALUE_GET_OBJ(frame->capture_this); owner; owner = owner->shape->proto) {
                uint32_t i;
                JSShapeProperty *props = get_shape_prop(owner->shape);
                /* Do not run proxy traps or getters while walking live frames. */
                if (owner->class_id == JS_CLASS_PROXY) break;
                if (js_poll_interrupts(ctx)) { JS_FreeValue(ctx, object); goto failed; }
                for (i = 0; i < owner->shape->prop_count; i++) {
                    JSValueConst value;
                    if ((i & 1023) == 0 && js_poll_interrupts(ctx)) { JS_FreeValue(ctx, object); goto failed; }
                    if (!props[i].atom || (props[i].flags & JS_PROP_TMASK) != JS_PROP_NORMAL) continue;
                    value = owner->prop[i].u.value;
                    if (JS_IsNull(site->method) && JS_IsObject(value) && JS_VALUE_GET_OBJ(value) == function) {
                        site->method = JS_AtomToString(ctx, props[i].atom);
                        if (JS_IsException(site->method)) { JS_FreeValue(ctx, object); goto failed; }
                    }
                    if (!constructor_seen && props[i].atom == JS_ATOM_constructor) {
                        const char *type;
                        constructor_seen = TRUE;
                        type = get_prop_string(ctx, value, JS_ATOM_name);
                        if (type) { site->type = JS_NewString(ctx, type); JS_FreeCString(ctx, type); }
                        if (JS_IsException(site->type) || JS_HasException(ctx)) { JS_FreeValue(ctx, object); goto failed; }
                    }
                }
            }
        }
        name = get_prop_string(ctx, frame->cur_func, JS_ATOM_name);
        if (!name && JS_HasException(ctx)) { JS_FreeValue(ctx, object); goto failed; }
        if (name) {
            if (name[0]) site->name = JS_NewString(ctx, name);
            JS_FreeCString(ctx, name);
            if (JS_IsException(site->name)) { JS_FreeValue(ctx, object); goto failed; }
        }
        if (js_class_has_bytecode(function->class_id)) {
            JSFunctionBytecode *b = function->u.func.function_bytecode;
            site->eval = b->is_direct_or_indirect_eval;
            if (b->has_debug) {
                site->line = find_line_num(ctx, b, frame->cur_pc - b->byte_code_buf - 1, &site->column);
                if (site->line == 1) site->column += b->debug.script_column_offset;
                site->line += b->debug.script_line_offset;
                site->file = JS_AtomToString(ctx, b->debug.filename);
                if (JS_IsException(site->file)) { JS_FreeValue(ctx, object); goto failed; }
            }
        } else site->native = TRUE;
        if (JS_DefinePropertyValueUint32(ctx, array, count++, object, JS_PROP_C_W_E) < 0) goto failed;
    }
    return array;
failed:
    JS_FreeValue(ctx, array);
    return JS_EXCEPTION;
}
/* State is a null-prototype object so retained call sites and cyclic formatters
 * participate in the existing QuickJS collector. */
static JSValue qjs_stack_get(JSContext *ctx, JSValueConst receiver, int argc,
                             JSValueConst *argv, int magic, JSValue *data)
{
    JSValue state = data[0], cached, target, ctor, sites, formatter, value;
    JSValue args[2];
    int ready;
    cached = JS_GetPropertyUint32(ctx, state, 3);
    ready = JS_ToBool(ctx, cached); JS_FreeValue(ctx, cached);
    if (ready < 0) return JS_EXCEPTION;
    if (ready) return JS_GetPropertyUint32(ctx, state, 4);
    target = JS_GetPropertyUint32(ctx, state, 0);
    ctor = JS_GetPropertyUint32(ctx, state, 1);
    sites = JS_GetPropertyUint32(ctx, state, 2);
    formatter = ctx->stack_formatting ? JS_UNDEFINED : JS_GetPropertyStr(ctx, ctor, "prepareStackTrace");
    if (JS_IsException(formatter)) { value = JS_EXCEPTION; goto done; }
    if (JS_IsFunction(ctx, formatter)) {
        args[0] = target; args[1] = sites;
        ctx->stack_formatting = TRUE;
        value = JS_Call(ctx, formatter, ctor, 2, args);
        ctx->stack_formatting = FALSE;
    } else {
        JSValue length;
        uint32_t count = 0, i;
        value = js_error_toString(ctx, target, 0, NULL);
        length = JS_GetProperty(ctx, sites, JS_ATOM_length);
        if (JS_ToUint32(ctx, &count, length) < 0) { JS_FreeValue(ctx, value); value = JS_EXCEPTION; }
        JS_FreeValue(ctx, length);
        for (i = 0; i < count && !JS_IsException(value); i++) {
            JSValue site = JS_GetPropertyUint32(ctx, sites, i);
            JSValue text = qjs_callsite_get(ctx, site, 0, NULL, QCS_STRING);
            JS_FreeValue(ctx, site);
            if (JS_IsException(text)) { JS_FreeValue(ctx, value); value = text; break; }
            JSValue separator = JS_NewString(ctx, "\n    at ");
            if (JS_IsException(separator)) { JS_FreeValue(ctx, value); JS_FreeValue(ctx, text); value = JS_EXCEPTION; break; }
            value = JS_ConcatString(ctx, value, separator);
            if (JS_IsException(value)) { JS_FreeValue(ctx, text); break; }
            value = JS_ConcatString(ctx, value, text);
        }
    }
    if (!JS_IsException(value)) {
        if (JS_SetPropertyUint32(ctx, state, 4, JS_DupValue(ctx, value)) < 0 ||
            JS_SetPropertyUint32(ctx, state, 3, JS_TRUE) < 0) { JS_FreeValue(ctx, value); value = JS_EXCEPTION; }
        else {
            JS_SetPropertyUint32(ctx, state, 0, JS_UNDEFINED);
            JS_SetPropertyUint32(ctx, state, 1, JS_UNDEFINED);
            JS_SetPropertyUint32(ctx, state, 2, JS_UNDEFINED);
        }
    }
done:
    JS_FreeValue(ctx, target); JS_FreeValue(ctx, ctor); JS_FreeValue(ctx, sites); JS_FreeValue(ctx, formatter);
    return value;
}
static JSValue qjs_stack_set(JSContext *ctx, JSValueConst receiver, int argc,
                             JSValueConst *argv, int magic, JSValue *data)
{
    if (JS_SetPropertyUint32(ctx, data[0], 4, JS_DupValue(ctx, argv[0])) < 0 ||
        JS_SetPropertyUint32(ctx, data[0], 3, JS_TRUE) < 0) return JS_EXCEPTION;
    JS_SetPropertyUint32(ctx, data[0], 0, JS_UNDEFINED);
    JS_SetPropertyUint32(ctx, data[0], 1, JS_UNDEFINED);
    JS_SetPropertyUint32(ctx, data[0], 2, JS_UNDEFINED);
    return JS_UNDEFINED;
}
static JSValue qjs_capture_stack_trace(JSContext *ctx, JSValueConst receiver,
                                       int argc, JSValueConst *argv)
{
    JSValue ctor, limit_value, sites = JS_UNDEFINED, state = JS_UNDEFINED, getter, setter;
    double number;
    uint32_t limit;
    if (!JS_IsObject(argv[0])) return JS_ThrowTypeErrorNotAnObject(ctx);
    ctor = JS_GetProperty(ctx, ctx->class_proto[JS_CLASS_ERROR], JS_ATOM_constructor);
    if (JS_IsException(ctor)) return ctor;
    limit_value = JS_GetPropertyStr(ctx, ctor, "stackTraceLimit");
    if (JS_IsException(limit_value)) goto failed;
    if (!JS_IsNumber(limit_value)) {
        JS_FreeValue(ctx, limit_value); JS_FreeValue(ctx, ctor);
        if (JS_DefinePropertyValue(ctx, argv[0], JS_ATOM_stack, JS_UNDEFINED, JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE | JS_PROP_THROW) < 0) return JS_EXCEPTION;
        return JS_UNDEFINED;
    }
    JS_ToFloat64(ctx, &number, limit_value); JS_FreeValue(ctx, limit_value);
    limit = isnan(number) || number <= 0 ? 0 : number >= UINT32_MAX ? UINT32_MAX : (uint32_t)number;
    sites = qjs_capture_sites(ctx, argc > 1 && JS_IsFunction(ctx, argv[1]) ? argv[1] : JS_GetActiveFunction(ctx), limit);
    if (JS_IsException(sites)) goto failed;
    state = JS_NewObjectProto(ctx, JS_NULL);
    if (JS_IsException(state)) goto failed;
    if (JS_SetPropertyUint32(ctx, state, 0, JS_DupValue(ctx, argv[0])) < 0 ||
        JS_SetPropertyUint32(ctx, state, 1, JS_DupValue(ctx, ctor)) < 0 ||
        JS_SetPropertyUint32(ctx, state, 2, JS_DupValue(ctx, sites)) < 0 ||
        JS_SetPropertyUint32(ctx, state, 3, JS_FALSE) < 0 ||
        JS_SetPropertyUint32(ctx, state, 4, JS_UNDEFINED) < 0) goto failed;
    getter = JS_NewCFunctionData(ctx, qjs_stack_get, 0, 0, 1, &state);
    if (JS_IsException(getter)) goto failed;
    setter = JS_NewCFunctionData(ctx, qjs_stack_set, 1, 0, 1, &state);
    if (JS_IsException(setter)) { JS_FreeValue(ctx, getter); goto failed; }
    if (JS_DefinePropertyGetSet(ctx, argv[0], JS_ATOM_stack, getter, setter, JS_PROP_CONFIGURABLE | JS_PROP_THROW) < 0) goto failed;
    JS_FreeValue(ctx, state); JS_FreeValue(ctx, sites); JS_FreeValue(ctx, ctor);
    return JS_UNDEFINED;
failed:
    JS_FreeValue(ctx, state); JS_FreeValue(ctx, sites); JS_FreeValue(ctx, ctor);
    return JS_EXCEPTION;
}
