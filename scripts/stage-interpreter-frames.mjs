import {readFileSync,writeFileSync} from 'node:fs'

// Direct bytecode calls share one interpreter invocation. Native callbacks and
// constructors retain their existing entry path and native re-entry guard.
export function stageInterpreterFrames(file){
  let source=readFileSync(file,'utf8')
  const replace=(from,to)=>{if(source.split(from).length!==2)throw Error('Unexpected interpreter integration site: '+from);source=source.replace(from,to)}
  const fields={
    'JSContext *':['caller_ctx','ctx'],
    'JSObject *':['p'],
    'JSFunctionBytecode *':['b'],
    'JSStackFrame *':['sf'],
    'const uint8_t *':['pc'],
    'int ':['opcode','argc','flags','arg_allocated_size'],
    'JSValue ':['func_obj','this_obj','new_target'],
    'JSValue *':['argv','local_buf','stack_buf','var_buf','arg_buf','sp'],
    'JSVarRef **':['var_refs'],
  }
  const names=Object.values(fields).flat()
  const declarations=Object.entries(fields).flatMap(([type,names])=>names.map(name=>`    ${type}${name};`)).join('\n')
  const marker='/* argv[] is modified if (flags & JS_CALL_FLAG_COPY_ARGV) = 0. */\nstatic JSValue JS_CallInternal(JSContext *caller_ctx, JSValueConst func_obj,'
  replace(marker,`typedef struct QJSInterpreterFrame {
    struct QJSInterpreterFrame *previous;
    JSStackFrame child_frame;
    int child_argc, argument_prefix, tail_call;
${declarations}
} QJSInterpreterFrame;

${marker}`)
  replace('    uint32_t native_reentry_depth;','    uint32_t native_reentry_depth;\n    uint32_t interpreter_frame_depth;')
  replace('    size_t alloca_size;\n\n#if !DIRECT_DISPATCH','    size_t alloca_size;\n    QJSInterpreterFrame *parents = NULL;\n\n#if !DIRECT_DISPATCH')
  replace('    b = p->u.func.function_bytecode;\n\n    if (unlikely(argc < b->arg_count', ' enter_bytecode:\n    b = p->u.func.function_bytecode;\n\n    if (unlikely(argc < b->arg_count')
  replace('    if (js_check_stack_overflow(rt, alloca_size))\n        return JS_ThrowStackOverflow(caller_ctx);','    if (!parents && js_check_stack_overflow(rt, alloca_size))\n        return JS_ThrowStackOverflow(caller_ctx);')
  replace('    local_buf = alloca(alloca_size);','    local_buf = parents ? (JSValue *)(parents + 1) : alloca(alloca_size);')
  for(const method of [false,true]){
    const original=method?`                ret_val = JS_CallInternal(ctx, call_argv[-1], call_argv[-2],
                                          JS_UNDEFINED, call_argc, call_argv, 0);`:`                ret_val = JS_CallInternal(ctx, call_argv[-1], JS_UNDEFINED,
                                          JS_UNDEFINED, call_argc, call_argv, 0);`
    replace(original,`                if (JS_VALUE_GET_TAG(call_argv[-1]) == JS_TAG_OBJECT &&
                    JS_VALUE_GET_OBJ(call_argv[-1])->class_id == JS_CLASS_BYTECODE_FUNCTION) {
                    JSFunctionBytecode *child = JS_VALUE_GET_OBJ(call_argv[-1])->u.func.function_bytecode;
                    size_t bytes = sizeof(JSValue) * ((call_argc < child->arg_count ? child->arg_count : 0) + child->var_count + child->stack_size) + sizeof(JSVarRef *) * child->var_ref_count;
                    QJSInterpreterFrame *next;
                    if (js_poll_interrupts(ctx)) goto exception;
                    if (rt->interpreter_frame_depth >= 4096) {
                        JS_ThrowStackOverflow(ctx);
                        goto exception;
                    }
                    next = js_malloc(ctx, sizeof(*next) + bytes);
                    if (!next) goto exception;
${names.map(name=>`                    next->${name} = ${name};`).join('\n')}
                    next->previous = parents;
                    next->child_argc = call_argc;
                    next->argument_prefix = ${method?2:1};
                    next->tail_call = opcode == ${method?'OP_tail_call_method':'OP_tail_call'};
                    parents = next;
                    rt->interpreter_frame_depth++;
                    caller_ctx = ctx;
                    func_obj = call_argv[-1];
                    this_obj = ${method?'call_argv[-2]':'JS_UNDEFINED'};
                    new_target = JS_UNDEFINED;
                    argc = call_argc;
                    argv = call_argv;
                    flags = 0;
                    sf = &next->child_frame;
                    p = JS_VALUE_GET_OBJ(func_obj);
                    goto enter_bytecode;
                }
${original}`)
  }
  replace('    rt->current_stack_frame = sf->prev_frame;\n    return ret_val;\n}\n\nJSValue JS_Call(',`    rt->current_stack_frame = sf->prev_frame;
    if (parents) {
        QJSInterpreterFrame *finished = parents;
        int child_argc = finished->child_argc;
        int prefix = finished->argument_prefix;
        int tail = finished->tail_call;
${names.map(name=>`        ${name} = finished->${name};`).join('\n')}
        parents = finished->previous;
        rt->interpreter_frame_depth--;
        js_free(ctx, finished);
        if (JS_IsException(ret_val)) goto exception;
        if (tail) goto done;
        for (i = -(child_argc + prefix); i < 0; i++) JS_FreeValue(ctx, sp[i]);
        sp -= child_argc + prefix;
        *sp++ = ret_val;
        goto restart;
    }
    return ret_val;
}

JSValue JS_Call(`)
  writeFileSync(file,source)
}
