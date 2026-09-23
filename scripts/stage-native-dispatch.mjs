import {readFileSync,writeFileSync} from 'node:fs'

// Native calls do not need the bytecode interpreter's large native frame.
// Keep the existing interrupt/depth prologue on every entry, in a small wrapper.
export function stageNativeDispatch(file){
  let source=readFileSync(file,'utf8')
  const signature=`static JSValue JS_CallInternal(JSContext *caller_ctx, JSValueConst func_obj,
                               JSValueConst this_obj, JSValueConst new_target,
                               int argc, JSValue *argv, int flags)`
  const definition=signature+'\n{'
  if(source.split(definition).length!==2)throw Error('Unexpected native dispatch definition')
  const start=source.indexOf('    if (js_poll_interrupts(caller_ctx))',source.indexOf(definition))
  const end=source.indexOf('    if (unlikely(JS_VALUE_GET_TAG(func_obj) != JS_TAG_OBJECT)) {',start)
  if(start<0||end<start)throw Error('Missing guarded interpreter entry')
  const prologue=source.slice(start,end)
  if(!prologue.includes('QJSCallDepthGuard')||!prologue.includes('native_reentry_depth++'))throw Error('Missing native depth guard')
  source=source.slice(0,start)+source.slice(end)
  // Prevent LLVM from merging the large frame back into the dispatch wrapper.
  const bodySignature=signature.replace('static JSValue','static __attribute__((noinline)) JSValue').replace('JS_CallInternal(','JS_CallInternalBody(')
  source=source.replace(definition,`${bodySignature};

${signature}
{
    JSRuntime *rt = caller_ctx->rt;
${prologue}
    if (JS_VALUE_GET_TAG(func_obj) == JS_TAG_OBJECT) {
        JSObject *p = JS_VALUE_GET_OBJ(func_obj);
        if (p->class_id != JS_CLASS_BYTECODE_FUNCTION) {
            JSClassCall *call_func = rt->class_array[p->class_id].call;
            if (!call_func)
                return JS_ThrowTypeError(caller_ctx, "not a function");
            return call_func(caller_ctx, func_obj, this_obj, argc,
                             (JSValueConst *)argv, flags);
        }
    }
    return JS_CallInternalBody(caller_ctx, func_obj, this_obj, new_target,
                               argc, argv, flags);
}

${bodySignature}
{`)
  writeFileSync(file,source)
}
