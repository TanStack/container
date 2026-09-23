import {readFileSync,writeFileSync} from 'node:fs'

export function stageVMDynamicImport(path){
  let source=readFileSync(path,'utf8')
  if(source.includes('/* VM_DYNAMIC_IMPORT_CALLBACK */'))return
  const replace=(from,to)=>{if(source.split(from).length!==2)throw Error('Unexpected dynamic VM site: '+from.slice(0,70));source=source.replace(from,to)}
  replace('typedef struct JSFunctionBytecode {','typedef struct JSFunctionBytecode {\n    JSValue vm_import_callback; /* VM_DYNAMIC_IMPORT_CALLBACK */')
  // Keep the GC header first. JSValue must follow the existing header instead.
  replace('typedef struct JSFunctionBytecode {\n    JSValue vm_import_callback; /* VM_DYNAMIC_IMPORT_CALLBACK */\n    JSGCObjectHeader header;', 'typedef struct JSFunctionBytecode {\n    JSGCObjectHeader header;\n    JSValue vm_import_callback; /* VM_DYNAMIC_IMPORT_CALLBACK */')
  replace('static void free_function_bytecode(JSRuntime *rt, JSFunctionBytecode *b)\n{\n    int i;', 'static void free_function_bytecode(JSRuntime *rt, JSFunctionBytecode *b)\n{\n    int i;\n    JS_FreeValueRT(rt, b->vm_import_callback);')
  replace('JSFunctionBytecode *b = (JSFunctionBytecode *)gp;\n            int i;', 'JSFunctionBytecode *b = (JSFunctionBytecode *)gp;\n            int i;\n            JS_MarkValue(rt, b->vm_import_callback, mark_func);')
  const helpers=`
static int vm_attach_import(JSContext *ctx, JSFunctionBytecode *root, JSValueConst callback) {
    JSFunctionBytecode **queue = js_malloc(ctx, 4096 * sizeof(*queue));
    int length = 1;
    if (!queue) return -1;
    queue[0] = root;
    for (int i = 0; i < length; i++) {
        JSFunctionBytecode *b = queue[i];
        set_value(ctx, &b->vm_import_callback, JS_DupValue(ctx, callback));
        for (int j = 0; j < b->cpool_count; j++) if (JS_VALUE_GET_TAG(b->cpool[j]) == JS_TAG_FUNCTION_BYTECODE) {
            if (length == 4096) { js_free(ctx, queue); JS_ThrowRangeError(ctx, "VM import callback bytecode limit"); return -1; }
            queue[length++] = JS_VALUE_GET_PTR(b->cpool[j]);
        }
    }
    js_free(ctx, queue); return 0;
}
static JSValue vm_import_job(JSContext *ctx, int argc, JSValueConst *argv) {
    JSValue result = JS_Call(ctx, argv[4], JS_UNDEFINED, 2, argv + 2);
    JSValue settled;
    if (JS_IsException(result)) {
        result = JS_GetException(ctx);
        settled = JS_Call(ctx, argv[1], JS_UNDEFINED, 1, (JSValueConst *)&result);
    } else settled = JS_Call(ctx, argv[0], JS_UNDEFINED, 1, (JSValueConst *)&result);
    JS_FreeValue(ctx, result); JS_FreeValue(ctx, settled); return JS_UNDEFINED;
}
`
  replace('static JSValue js_dynamic_import(JSContext *ctx, JSValueConst specifier, JSValueConst options)\n{',helpers+'\nstatic JSValue js_dynamic_import(JSContext *ctx, JSValueConst specifier, JSValueConst options)\n{')
  const site='            if (js_class_has_bytecode(object->class_id) && object->u.func.function_bytecode->is_guest_script) {'
  replace(site,`            if (js_class_has_bytecode(object->class_id) && JS_IsFunction(ctx, object->u.func.function_bytecode->vm_import_callback)) {
                JSValueConst callback_args[5] = {resolving_funcs[0], resolving_funcs[1], specifier_str, attributes, object->u.func.function_bytecode->vm_import_callback};
                if (JS_EnqueueJob(ctx, vm_import_job, 5, callback_args) < 0) goto exception;
                JS_FreeValue(ctx, specifier_str); JS_FreeValue(ctx, attributes); JS_FreeValue(ctx, basename_val);
                JS_FreeValue(ctx, resolving_funcs[0]); JS_FreeValue(ctx, resolving_funcs[1]);
                return promise;
            }
`+site)
  replace('    result = JS_NewCFunctionData(ctx, qjs_run_script, 1, 0, 1, &compiled);',`    if (argc > 4 && !JS_IsUndefined(argv[4])) {
        if (!JS_IsFunction(ctx, argv[4]) || vm_attach_import(ctx, JS_VALUE_GET_PTR(compiled), argv[4]) < 0) {
            JS_FreeValue(ctx, compiled); return JS_EXCEPTION;
        }
    }
    result = JS_NewCFunctionData(ctx, qjs_run_script, 1, 0, 1, &compiled);`)
  writeFileSync(path,source)
}
