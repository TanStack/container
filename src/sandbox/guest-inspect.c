#ifndef QJS_INSPECTION_INCLUDED
#define QJS_INSPECTION_INCLUDED
/* Include after QuickJS's proxy and promise definitions. These helpers inspect
 * guest engine state only. Property enumeration uses ordinary own-property
 * semantics, so the inspector must unwrap proxies before enumerating them.
 * The embedding must keep this binding private to its builtin implementation.
 * No helper is installed as a guest global or module. */

/* Class identity comes from the engine, not Symbol.toStringTag, prototypes,
 * constructors or instanceof. Proxies intentionally keep their own identity. */
#define QJS_INSPECT_TYPES(X) \
    /* QuickJS guest values cannot contain a V8 External slot. */ \
    X(isExternal, FALSE) \
    X(isAsyncFunction, class_id == JS_CLASS_ASYNC_FUNCTION || class_id == JS_CLASS_ASYNC_GENERATOR_FUNCTION) \
    X(isGeneratorFunction, class_id == JS_CLASS_GENERATOR_FUNCTION || class_id == JS_CLASS_ASYNC_GENERATOR_FUNCTION) \
    X(isGeneratorObject, class_id == JS_CLASS_GENERATOR || class_id == JS_CLASS_ASYNC_GENERATOR) \
    X(isArgumentsObject, class_id == JS_CLASS_ARGUMENTS || class_id == JS_CLASS_MAPPED_ARGUMENTS) \
    X(isAnyArrayBuffer, class_id == JS_CLASS_ARRAY_BUFFER || class_id == JS_CLASS_SHARED_ARRAY_BUFFER) \
    X(isArrayBuffer, class_id == JS_CLASS_ARRAY_BUFFER) \
    X(isSharedArrayBuffer, class_id == JS_CLASS_SHARED_ARRAY_BUFFER) \
    X(isArrayBufferView, typed_array || class_id == JS_CLASS_DATAVIEW) \
    X(isTypedArray, typed_array) \
    X(isDataView, class_id == JS_CLASS_DATAVIEW) \
    X(isUint8ClampedArray, class_id == JS_CLASS_UINT8C_ARRAY) \
    X(isInt8Array, class_id == JS_CLASS_INT8_ARRAY) \
    X(isUint8Array, class_id == JS_CLASS_UINT8_ARRAY) \
    X(isInt16Array, class_id == JS_CLASS_INT16_ARRAY) \
    X(isUint16Array, class_id == JS_CLASS_UINT16_ARRAY) \
    X(isInt32Array, class_id == JS_CLASS_INT32_ARRAY) \
    X(isUint32Array, class_id == JS_CLASS_UINT32_ARRAY) \
    X(isBigInt64Array, class_id == JS_CLASS_BIG_INT64_ARRAY) \
    X(isBigUint64Array, class_id == JS_CLASS_BIG_UINT64_ARRAY) \
    X(isFloat16Array, class_id == JS_CLASS_FLOAT16_ARRAY) \
    X(isFloat32Array, class_id == JS_CLASS_FLOAT32_ARRAY) \
    X(isFloat64Array, class_id == JS_CLASS_FLOAT64_ARRAY) \
    X(isBoxedPrimitive, class_id == JS_CLASS_NUMBER || class_id == JS_CLASS_STRING || class_id == JS_CLASS_BOOLEAN || class_id == JS_CLASS_SYMBOL || class_id == JS_CLASS_BIG_INT) \
    X(isNumberObject, class_id == JS_CLASS_NUMBER) \
    X(isStringObject, class_id == JS_CLASS_STRING) \
    X(isBooleanObject, class_id == JS_CLASS_BOOLEAN) \
    X(isSymbolObject, class_id == JS_CLASS_SYMBOL) \
    X(isBigIntObject, class_id == JS_CLASS_BIG_INT) \
    X(isDate, class_id == JS_CLASS_DATE) \
    X(isRegExp, class_id == JS_CLASS_REGEXP) \
    X(isNativeError, class_id == JS_CLASS_ERROR) \
    X(isMap, class_id == JS_CLASS_MAP) \
    X(isSet, class_id == JS_CLASS_SET) \
    X(isWeakMap, class_id == JS_CLASS_WEAKMAP) \
    X(isWeakSet, class_id == JS_CLASS_WEAKSET) \
    X(isMapIterator, class_id == JS_CLASS_MAP_ITERATOR) \
    X(isSetIterator, class_id == JS_CLASS_SET_ITERATOR) \
    X(isPromise, class_id == JS_CLASS_PROMISE) \
    X(isProxy, class_id == JS_CLASS_PROXY) \
    X(isModuleNamespaceObject, class_id == JS_CLASS_MODULE_NS)

#define QJS_INSPECT_TYPE_ID(name, condition) QJS_INSPECT_##name,
enum { QJS_INSPECT_TYPES(QJS_INSPECT_TYPE_ID) QJS_INSPECT_TYPE_COUNT };
#undef QJS_INSPECT_TYPE_ID

static JSValue qjs_inspect_type(JSContext *ctx, JSValueConst receiver,
                                int argc, JSValueConst *argv, int magic)
{
    int class_id = argc && JS_IsObject(argv[0]) ? JS_VALUE_GET_OBJ(argv[0])->class_id : 0;
    BOOL typed_array = class_id >= JS_CLASS_UINT8C_ARRAY && class_id <= JS_CLASS_FLOAT64_ARRAY;
    switch (magic) {
#define QJS_INSPECT_TYPE_CASE(name, condition) case QJS_INSPECT_##name: return JS_NewBool(ctx, condition);
        QJS_INSPECT_TYPES(QJS_INSPECT_TYPE_CASE)
#undef QJS_INSPECT_TYPE_CASE
    default: return JS_ThrowInternalError(ctx, "invalid inspection type predicate");
    }
}

#define QJS_INSPECT_TYPE_ENTRY(name, condition) JS_CFUNC_MAGIC_DEF(#name, 1, qjs_inspect_type, QJS_INSPECT_##name),
static const JSCFunctionListEntry qjs_inspect_type_functions[] = {
    QJS_INSPECT_TYPES(QJS_INSPECT_TYPE_ENTRY)
};
#undef QJS_INSPECT_TYPE_ENTRY
#undef QJS_INSPECT_TYPES

static JSValue qjs_inspect_non_index_properties(JSContext *ctx, JSValueConst receiver,
                                               int argc, JSValueConst *argv)
{
    JSPropertyEnum *properties;
    uint32_t length, i, index, output_index = 0;
    int filter = 0, flags = 0;
    JSValue result;
    if (argc == 0 || !JS_IsObject(argv[0]))
        return JS_ThrowTypeError(ctx, "inspection requires an object");
    if (argc > 1 && JS_ToInt32(ctx, &filter, argv[1]) < 0) return JS_EXCEPTION;
    if (filter < 0 || filter > 31)
        return JS_ThrowRangeError(ctx, "invalid inspection property filter");
    /* Match V8's PropertyFilter bit values used by Node's private binding. */
    if (!(filter & 8)) flags |= JS_GPN_STRING_MASK;
    if (!(filter & 16)) flags |= JS_GPN_SYMBOL_MASK;
    if (filter & 2) flags |= JS_GPN_ENUM_ONLY;
    if (JS_GetOwnPropertyNames(ctx, &properties, &length, argv[0], flags) < 0)
        return JS_EXCEPTION;
    result = JS_NewArray(ctx);
    if (JS_IsException(result)) goto fail;
    for (i = 0; i < length; i++) {
        if (js_poll_interrupts(ctx)) goto fail;
        if (JS_AtomIsArrayIndex(ctx, &index, properties[i].atom)) continue;
        if (filter & (1 | 4)) {
            JSPropertyDescriptor descriptor;
            int found = JS_GetOwnProperty(ctx, &descriptor, argv[0], properties[i].atom);
            if (found < 0) goto fail;
            if (!found) continue;
            BOOL keep = (!(filter & 1) || (descriptor.flags & (JS_PROP_WRITABLE | JS_PROP_GETSET))) &&
                        (!(filter & 4) || (descriptor.flags & JS_PROP_CONFIGURABLE));
            JS_FreeValue(ctx, descriptor.value);
            JS_FreeValue(ctx, descriptor.getter);
            JS_FreeValue(ctx, descriptor.setter);
            if (!keep) continue;
        }
        JSValue key = JS_AtomToValue(ctx, properties[i].atom);
        if (JS_IsException(key)) goto fail;
        if (JS_DefinePropertyValueUint32(ctx, result, output_index++, key, JS_PROP_C_W_E) < 0)
            goto fail;
    }
    JS_FreePropertyEnum(ctx, properties, length);
    return result;
fail:
    JS_FreePropertyEnum(ctx, properties, length);
    JS_FreeValue(ctx, result);
    return JS_EXCEPTION;
}

static JSValue qjs_inspect_constructor_name(JSContext *ctx, JSValueConst receiver,
                                          int argc, JSValueConst *argv)
{
    if (!argc || !JS_IsObject(argv[0])) return JS_ThrowTypeError(ctx, "inspection requires an object");
    JSObject *object = JS_VALUE_GET_OBJ(argv[0]);
    JSAtom fallback = ctx->rt->class_array[object->class_id].class_name;
    /* Function names describe callables, not their own constructor. */
    if (js_class_has_bytecode(object->class_id) || object->class_id == JS_CLASS_C_FUNCTION ||
        object->class_id == JS_CLASS_C_FUNCTION_DATA || object->class_id == JS_CLASS_BOUND_FUNCTION)
        return JS_AtomToString(ctx, fallback);
    if (object->inspection_name != JS_ATOM_NULL && object->inspection_name != JS_ATOM_empty_string &&
        object->inspection_name != JS_ATOM_Object)
        return JS_AtomToString(ctx, object->inspection_name);
    /* Inspect data descriptors directly. Never invoke constructor getters or
     * cross a proxy while walking prototypes. */
    for (JSObject *prototype = object->shape->proto; prototype; prototype = prototype->shape->proto) {
        JSProperty *property;
        if (js_poll_interrupts(ctx)) return JS_EXCEPTION;
        if (prototype->class_id == JS_CLASS_PROXY) break;
        JSShapeProperty *shape = find_own_property(&property, prototype, JS_ATOM_constructor);
        if (!shape) continue;
        if ((shape->flags & JS_PROP_TMASK) != JS_PROP_NORMAL || !JS_IsObject(property->u.value)) break;
        JSObject *constructor = JS_VALUE_GET_OBJ(property->u.value);
        if (constructor->class_id == JS_CLASS_PROXY) break;
        if (!js_class_has_bytecode(constructor->class_id) && constructor->class_id != JS_CLASS_C_FUNCTION &&
            constructor->class_id != JS_CLASS_C_FUNCTION_DATA && constructor->class_id != JS_CLASS_BOUND_FUNCTION) break;
        JSAtom name = constructor->inspection_name;
        if (name != JS_ATOM_NULL && name != JS_ATOM_empty_string && name != JS_ATOM_Object)
            return JS_AtomToString(ctx, name);
        break;
    }
    return JS_AtomToString(ctx, fallback);
}

static JSValue qjs_inspect_proxy_details(JSContext *ctx, JSValueConst receiver,
                                        int argc, JSValueConst *argv)
{
    JSProxyData *proxy;
    JSValue values[2];
    if (argc == 0 || !(proxy = JS_GetOpaque(argv[0], JS_CLASS_PROXY)))
        return JS_UNDEFINED;
    values[0] = proxy->is_revoked ? JS_NULL : proxy->target;
    if (argc > 1 && !JS_ToBool(ctx, argv[1]))
        return JS_DupValue(ctx, values[0]);
    values[1] = proxy->is_revoked ? JS_NULL : proxy->handler;
    return js_create_array(ctx, 2, values);
}

static JSValue qjs_inspect_promise_details(JSContext *ctx, JSValueConst receiver,
                                          int argc, JSValueConst *argv)
{
    /* QuickJS returns -1 for non-promises, outside its nonnegative enum. */
    int state;
    JSValue values[2], result;
    if (argc == 0 || (state = (int)JS_PromiseState(ctx, argv[0])) < 0)
        return JS_UNDEFINED;
    /* Match Node's internal util binding constants explicitly. */
    values[0] = JS_NewInt32(ctx, state == JS_PROMISE_PENDING ? 0 :
                                state == JS_PROMISE_FULFILLED ? 1 : 2);
    if (state == JS_PROMISE_PENDING)
        return js_create_array(ctx, 1, values);
    values[1] = JS_PromiseResult(ctx, argv[0]);
    result = js_create_array(ctx, 2, values);
    JS_FreeValue(ctx, values[1]);
    return result;
}

/* Snapshot live records directly. Calling iterator.next() would change program
 * behavior, and reflecting over the object could invoke user-defined hooks. */
static JSValue qjs_inspect_preview_entries(JSContext *ctx, JSValueConst receiver,
                                          int argc, JSValueConst *argv)
{
    JSMapState *map = NULL;
    JSMapIteratorData *iterator = NULL;
    JSValue *entries = NULL, result, wrapped[2];
    struct list_head *entry;
    int class_id, kind, count = 0, capacity, i;
    BOOL is_set, pairs;
    if (argc == 0 || !JS_IsObject(argv[0])) return JS_UNDEFINED;
    class_id = JS_VALUE_GET_OBJ(argv[0])->class_id;
    switch (class_id) {
    case JS_CLASS_MAP: case JS_CLASS_SET:
    case JS_CLASS_WEAKMAP: case JS_CLASS_WEAKSET:
        map = JS_GetOpaque(argv[0], class_id);
        is_set = class_id == JS_CLASS_SET || class_id == JS_CLASS_WEAKSET;
        kind = is_set ? JS_ITERATOR_KIND_KEY : JS_ITERATOR_KIND_KEY_AND_VALUE;
        break;
    case JS_CLASS_MAP_ITERATOR: case JS_CLASS_SET_ITERATOR:
        iterator = JS_GetOpaque(argv[0], class_id);
        is_set = class_id == JS_CLASS_SET_ITERATOR;
        kind = iterator->kind;
        if (!JS_IsUndefined(iterator->obj))
            map = JS_GetOpaque(iterator->obj, is_set ? JS_CLASS_SET : JS_CLASS_MAP);
        break;
    default:
        return JS_UNDEFINED;
    }
    pairs = kind == JS_ITERATOR_KIND_KEY_AND_VALUE;
    if (map) {
        if (map->record_count > INT32_MAX / (pairs ? 2 : 1))
            return JS_ThrowRangeError(ctx, "inspection snapshot is too large");
        capacity = map->record_count * (pairs ? 2 : 1);
        if ((uint64_t)capacity > SIZE_MAX / sizeof(*entries))
            return JS_ThrowRangeError(ctx, "inspection snapshot is too large");
        if (capacity) {
            /* Allocate before reading weak records. Allocation may collect dead
             * weak keys. After this allocation the snapshot only duplicates
             * references, so keys stay live until the result owns them. */
            entries = js_malloc(ctx, (size_t)capacity * sizeof(*entries));
            if (!entries) return JS_EXCEPTION;
        }
        entry = iterator && iterator->cur_record ? iterator->cur_record->link.next : map->records.next;
        for (; entry != &map->records; entry = entry->next) {
            JSMapRecord *record;
            if (js_poll_interrupts(ctx)) goto fail;
            record = list_entry(entry, JSMapRecord, link);
            if (record->empty || (map->is_weak && !js_weakref_is_live(record->key))) continue;
            if (pairs || kind == JS_ITERATOR_KIND_KEY)
                entries[count++] = JS_DupValue(ctx, record->key);
            if (pairs || kind == JS_ITERATOR_KIND_VALUE)
                entries[count++] = JS_DupValue(ctx, is_set ? record->key : record->value);
        }
    }
    result = js_create_array(ctx, count, entries);
    for (i = 0; i < count; i++) JS_FreeValue(ctx, entries[i]);
    js_free(ctx, entries);
    if (JS_IsException(result) || argc < 2 || !JS_ToBool(ctx, argv[1])) return result;
    wrapped[0] = result;
    wrapped[1] = JS_NewBool(ctx, pairs);
    result = js_create_array(ctx, 2, wrapped);
    JS_FreeValue(ctx, wrapped[0]);
    return result;
fail:
    for (i = 0; i < count; i++) JS_FreeValue(ctx, entries[i]);
    js_free(ctx, entries);
    return JS_EXCEPTION;
}

/* The embedding owns the returned value. This factory does not register a
 * module or global: only trusted builtin initialization may receive it. */
JSValue QJS_NewInspection(JSContext *ctx)
{
    JSValue object = JS_NewObjectProto(ctx, JS_NULL);
    if (JS_IsException(object)) return object;
    JSValue types = JS_NewObjectProto(ctx, JS_NULL);
    if (JS_IsException(types)) goto fail;
    for (size_t i = 0; i < countof(qjs_inspect_type_functions); i++) {
        const JSCFunctionListEntry *entry = &qjs_inspect_type_functions[i];
        JSValue function = JS_NewCFunctionMagic(ctx, qjs_inspect_type,
            entry->name, 1, JS_CFUNC_generic_magic, entry->magic);
        if (JS_IsException(function)) { JS_FreeValue(ctx, types); goto fail; }
        if (JS_DefinePropertyValueStr(ctx, types, entry->name, function,
                                     JS_PROP_C_W_E) < 0) {
            JS_FreeValue(ctx, types);
            goto fail;
        }
    }
    if (JS_DefinePropertyValueStr(ctx, object, "types", types, JS_PROP_C_W_E) < 0)
        goto fail;
    const struct { const char *name; JSCFunction *function; int length; } functions[] = {
        {"getProxyDetails", qjs_inspect_proxy_details, 2},
        {"getPromiseDetails", qjs_inspect_promise_details, 1},
        {"previewEntries", qjs_inspect_preview_entries, 2},
        {"getOwnNonIndexProperties", qjs_inspect_non_index_properties, 2},
        {"getConstructorName", qjs_inspect_constructor_name, 1},
    };
    for (size_t i = 0; i < countof(functions); i++) {
        JSValue function = JS_NewCFunction(ctx, functions[i].function,
                                          functions[i].name, functions[i].length);
        if (JS_IsException(function)) goto fail;
        if (JS_DefinePropertyValueStr(ctx, object, functions[i].name, function,
                                     JS_PROP_C_W_E) < 0) goto fail;
    }
    return object;
fail:
    JS_FreeValue(ctx, object);
    return JS_EXCEPTION;
}
#endif
