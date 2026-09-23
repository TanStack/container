import {readFileSync,writeFileSync} from 'node:fs'
// Applied only to private engine source copies, never the canonical checkout.
export function stageConstructorMetadata(file){
  let source=readFileSync(file,'utf8')
  const replace=(from,to)=>{if(source.split(from).length!==2)throw Error('Unexpected constructor metadata integration site: '+from);source=source.replace(from,to)}
  replace('    uint32_t weakref_count; ', '    uint32_t weakref_count; \n    JSAtom inspection_name; /* retained function name or allocation constructor name */')
  replace('    p->weakref_count = 0;', '    p->weakref_count = 0;\n    p->inspection_name = JS_ATOM_NULL;')
  replace('    p->free_mark = 1; /* used to tell the object is invalid when', '    JS_FreeAtomRT(rt, p->inspection_name);\n    p->inspection_name = JS_ATOM_NULL;\n    p->free_mark = 1; /* used to tell the object is invalid when')
  replace('    /* ES6 feature non compatible with ES5.1: length is configurable */', '    JSObject *p = JS_VALUE_GET_OBJ(func_obj);\n    JS_FreeAtom(ctx, p->inspection_name);\n    p->inspection_name = JS_DupAtom(ctx, name);\n    /* ES6 feature non compatible with ES5.1: length is configurable */')
  replace(`    if (JS_DefinePropertyValue(ctx, func_obj, JS_ATOM_name, name_str,
                               JS_PROP_CONFIGURABLE) < 0)
        return -1;
    js_method_set_home_object(ctx, func_obj, home_obj);`, `    JSAtom inspection_name = JS_ValueToAtom(ctx, name_str);
    if (inspection_name == JS_ATOM_NULL) { JS_FreeValue(ctx, name_str); return -1; }
    if (JS_DefinePropertyValue(ctx, func_obj, JS_ATOM_name, name_str,
                               JS_PROP_CONFIGURABLE) < 0) {
        JS_FreeAtom(ctx, inspection_name);
        return -1;
    }
    JSObject *p = JS_VALUE_GET_OBJ(func_obj);
    JS_FreeAtom(ctx, p->inspection_name);
    p->inspection_name = inspection_name;
    js_method_set_home_object(ctx, func_obj, home_obj);`)
  replace(`    if (name != JS_ATOM_NULL
    &&  JS_IsObject(obj)
    &&  !js_object_has_name(ctx, obj)
    &&  JS_DefinePropertyValue(ctx, obj, JS_ATOM_name, JS_AtomToString(ctx, name), flags) < 0) {
        return -1;
    }`, `    if (name != JS_ATOM_NULL && JS_IsObject(obj) && !js_object_has_name(ctx, obj)) {
        if (JS_DefinePropertyValue(ctx, obj, JS_ATOM_name, JS_AtomToString(ctx, name), flags) < 0)
            return -1;
        JSObject *p = JS_VALUE_GET_OBJ(obj);
        JS_FreeAtom(ctx, p->inspection_name);
        p->inspection_name = JS_DupAtom(ctx, name);
    }`)
  replace('        if (JS_DefinePropertyValue(ctx, obj, JS_ATOM_name, name_str, flags) < 0)\n            return -1;', `        JSAtom inspection_name = JS_ValueToAtom(ctx, name_str);
        if (inspection_name == JS_ATOM_NULL) { JS_FreeValue(ctx, name_str); return -1; }
        if (JS_DefinePropertyValue(ctx, obj, JS_ATOM_name, name_str, flags) < 0) {
            JS_FreeAtom(ctx, inspection_name); return -1;
        }
        JSObject *p = JS_VALUE_GET_OBJ(obj);
        JS_FreeAtom(ctx, p->inspection_name);
        p->inspection_name = inspection_name;`)
  replace(`    obj = JS_NewObjectProtoClass(ctx, proto, class_id);
    JS_FreeValue(ctx, proto);
    return obj;`, `    obj = JS_NewObjectProtoClass(ctx, proto, class_id);
    JS_FreeValue(ctx, proto);
    if (!JS_IsException(obj)) {
        JSValueConst target = ctor;
        while (JS_IsObject(target)) {
            JSObject *p = JS_VALUE_GET_OBJ(target);
            if (js_poll_interrupts(ctx)) { JS_FreeValue(ctx, obj); return JS_EXCEPTION; }
            if (p->class_id == JS_CLASS_PROXY) {
                if (p->u.proxy_data->is_revoked) break;
                target = p->u.proxy_data->target;
            } else if (p->class_id == JS_CLASS_BOUND_FUNCTION) {
                /* A bound newTarget has no original constructor identity.
                 * Ordinary new bound() already substitutes the target in
                 * QuickJS's bound constructor call path. */
                break;
            } else {
                JS_VALUE_GET_OBJ(obj)->inspection_name = JS_DupAtom(ctx, p->inspection_name);
                break;
            }
        }
    }
    return obj;`)
  writeFileSync(file,source)
}
