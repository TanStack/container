import {readFileSync,writeFileSync} from 'node:fs'

export function stageProcessTermination(path){
  let source=readFileSync(path,'utf8')
  const replace=(from,to)=>{
    if(source.split(from).length!==2)throw Error('Unexpected process termination patch site')
    source=source.replace(from,to)
  }
  replace('    BOOL current_exception_is_uncatchable : 8;',
    '    BOOL current_exception_is_uncatchable : 8;\n    BOOL process_exit_requested;')
  replace(`        return call_func(caller_ctx, func_obj, this_obj, argc,
                         (JSValueConst *)argv, flags);`, `        JSValue result = call_func(caller_ctx, func_obj, this_obj, argc,
                         (JSValueConst *)argv, flags);
        if (unlikely(rt->process_exit_requested)) {
            JS_FreeValue(caller_ctx, result);
            result = JS_ThrowInternalError(caller_ctx, "Process exited");
            JS_SetUncatchableException(caller_ctx, TRUE);
        }
        return result;`)
  replace('    res = e->job_func(ctx, e->argc, (JSValueConst *)e->argv);',`
    if (rt->process_exit_requested) {
        res = JS_ThrowInternalError(ctx, "Process exited");
        JS_SetUncatchableException(ctx, TRUE);
    } else {
        res = e->job_func(ctx, e->argc, (JSValueConst *)e->argv);
        if (rt->process_exit_requested) {
            JS_FreeValue(ctx, res);
            res = JS_ThrowInternalError(ctx, "Process exited");
            JS_SetUncatchableException(ctx, TRUE);
        }
    }`)
  source+=`
static JSValue qjs_terminate_process(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    ctx->rt->process_exit_requested = TRUE;
    JSValue result = JS_ThrowInternalError(ctx, "Process exited");
    JS_SetUncatchableException(ctx, TRUE);
    return result;
}
JSValue QJS_NewTermination(JSContext *ctx) {
    return JS_NewCFunction(ctx, qjs_terminate_process, "terminate", 0);
}
`
  writeFileSync(path,source)
}
