import {readFileSync,writeFileSync} from 'node:fs'

// Opt-in, after stageInterpreterFrames. Only resolved intrinsic generator
// next/return/throw calls at OP_call/OP_call_method are flattened. Function.call,
// apply, bound methods, iterator fast paths, async functions and async generators
// keep their existing implementation. No scheduler or microtask is introduced.
export function stageGeneratorResume(file){
  let source=readFileSync(file,'utf8')
  const replace=(from,to)=>{
    if(source.split(from).length!==2)throw Error('Unexpected generator resume integration site: '+from.slice(0,100))
    source=source.replace(from,to)
  }
  if(source.includes('QJS_DIRECT_GENERATOR_RESUME'))throw Error('Generator resume stage already applied')
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
  const expectedFrame=`typedef struct QJSInterpreterFrame {
    struct QJSInterpreterFrame *previous;
    JSStackFrame child_frame;
    int child_argc, argument_prefix, tail_call;
${Object.entries(fields).flatMap(([type,names])=>names.map(name=>`    ${type}${name};`)).join('\n')}
} QJSInterpreterFrame;`
  if(source.split(expectedFrame).length!==2)
    throw Error('Unexpected QJSInterpreterFrame shape: generator continuations must save every interpreter field')
  replace('typedef struct QJSInterpreterFrame {',`/* QJS_DIRECT_GENERATOR_RESUME */
static BOOL qjs_generator_can_resume(JSValueConst func_obj, JSValueConst this_obj);
static JSAsyncFunctionState *qjs_generator_resume_prepare(JSContext *ctx,
    JSValueConst func_obj, JSValueConst this_obj, int argc, JSValueConst *argv);
static JSValue qjs_generator_resume_finish(JSContext *ctx,
    JSValueConst generator, JSValue func_ret);

typedef struct QJSInterpreterFrame {`)
  replace('    int child_argc, argument_prefix, tail_call;',`    int child_argc, argument_prefix, tail_call;
    BOOL resume_generator;
    JSValue generator_owner, generator_arg;
    JSContext *generator_ctx;`)
  // Existing direct-bytecode continuations must not enter generator completion.
  const previous='                    next->previous = parents;'
  if(source.split(previous).length!==3)throw Error('Expected both iterative bytecode call sites')
  source=source.replaceAll(previous,'                    next->resume_generator = FALSE;\n'+previous)

  replace(`        if (flags & JS_CALL_FLAG_GENERATOR) {
            JSAsyncFunctionState *s = JS_VALUE_GET_PTR(func_obj);`,
`        if (flags & JS_CALL_FLAG_GENERATOR) {
        resume_generator:;
            JSAsyncFunctionState *s = JS_VALUE_GET_PTR(func_obj);
            arg_allocated_size = 0;`)

  for(const method of [false,true]){
    const receiver=method?'call_argv[-2]':'JS_UNDEFINED'
    const original=method?`                ret_val = JS_CallInternal(ctx, call_argv[-1], call_argv[-2],
                                          JS_UNDEFINED, call_argc, call_argv, 0);`:
`                ret_val = JS_CallInternal(ctx, call_argv[-1], JS_UNDEFINED,
                                          JS_UNDEFINED, call_argc, call_argv, 0);`
    replace(original,`                if (qjs_generator_can_resume(call_argv[-1], ${receiver})) {
                    QJSInterpreterFrame *next;
                    JSAsyncFunctionState *generator_state;
                    if (js_poll_interrupts(ctx)) goto exception;
                    if (rt->interpreter_frame_depth >= 4096) {
                        JS_ThrowStackOverflow(ctx);
                        goto exception;
                    }
                    /* Allocate before changing generator state. Its operand
                     * frame already belongs to JSAsyncFunctionState. */
                    next = js_malloc(ctx, sizeof(*next));
                    if (!next) goto exception;
${names.map(name=>`                    next->${name} = ${name};`).join('\n')}
                    next->previous = parents;
                    next->child_argc = call_argc;
                    next->argument_prefix = ${method?2:1};
                    next->tail_call = opcode == ${method?'OP_tail_call_method':'OP_tail_call'};
                    next->resume_generator = TRUE;
                    next->generator_owner = JS_DupValue(ctx, ${receiver});
                    next->generator_ctx = JS_VALUE_GET_OBJ(call_argv[-1])->u.cfunc.realm;
                    next->generator_arg = JS_UNDEFINED;
                    /* Retain the intrinsic call frame for backtraces and
                     * argument roots without retaining a native C frame. */
                    memset(&next->child_frame, 0, sizeof(next->child_frame));
                    next->child_frame.prev_frame = rt->current_stack_frame;
                    next->child_frame.cur_func = call_argv[-1];
                    next->child_frame.arg_count = call_argc ? call_argc : 1;
                    next->child_frame.arg_buf = call_argc ? call_argv : &next->generator_arg;
                    rt->current_stack_frame = &next->child_frame;
                    generator_state = qjs_generator_resume_prepare(next->generator_ctx,
                        call_argv[-1], ${receiver}, call_argc, call_argv);
                    parents = next;
                    rt->interpreter_frame_depth++;
                    caller_ctx = next->generator_ctx;
                    func_obj = JS_MKPTR(JS_TAG_INT, generator_state);
                    this_obj = generator_state->this_val;
                    new_target = JS_UNDEFINED;
                    argc = generator_state->argc;
                    argv = generator_state->frame.arg_buf;
                    flags = JS_CALL_FLAG_GENERATOR;
                    goto resume_generator;
                }
${original}`)
  }

  replace(`        QJSInterpreterFrame *finished = parents;
        int child_argc = finished->child_argc;`,
`        QJSInterpreterFrame *finished = parents;
        if (finished->resume_generator) {
            /* done_generator restored the intrinsic frame. Finish while that
             * frame and the generator owner are still rooted, then restore
             * the caller before releasing this heap continuation. */
            ret_val = qjs_generator_resume_finish(finished->generator_ctx,
                finished->generator_owner, ret_val);
            rt->current_stack_frame = finished->child_frame.prev_frame;
            JS_FreeValue(finished->generator_ctx, finished->generator_owner);
        }
        int child_argc = finished->child_argc;`)

  // Both native entry and the trampoline use exactly the same async-frame
  // completion routine. Do not duplicate its closure/free/return ownership.
  const resumeSignature='static JSValue async_func_resume(JSContext *ctx, JSAsyncFunctionState *s)\n{'
  const resumeStart=source.indexOf(resumeSignature)
  if(resumeStart<0||source.indexOf(resumeSignature,resumeStart+1)>=0)throw Error('Unexpected async resume definition')
  const resumeEnd=source.indexOf('\nstatic void __async_func_free(',resumeStart)
  if(resumeEnd<0)throw Error('Missing async resume boundary')
  const resume=source.slice(resumeStart,resumeEnd)
  const completionMarker='    if (JS_IsException(ret) || JS_IsUndefined(ret)) {'
  const completionStart=resume.indexOf(completionMarker)
  if(completionStart<0||resume.indexOf(completionMarker,completionStart+1)>=0||!resume.endsWith('    return ret;\n}\n'))throw Error('Unexpected async resume completion')
  const completion=resume.slice(completionStart)
  const completeHelper=`static JSValue qjs_async_func_resume_complete(JSContext *ctx,
    JSAsyncFunctionState *s, JSValue ret)
{
    JSRuntime *rt = ctx->rt;
    JSStackFrame *sf = &s->frame;
${completion}`
  replace(resume,completeHelper+'\n'+resume.slice(0,completionStart)+'    return qjs_async_func_resume_complete(ctx, s, ret);\n}\n')

  const generatorFunction=`static JSValue js_generator_function_call(JSContext *ctx, JSValueConst func_obj,
                                          JSValueConst this_obj,
                                          int argc, JSValueConst *argv,
                                          int flags)
{`
  replace(generatorFunction,`/* Match the intrinsic implementation, not a property name. Completed and
 * already-running generators retain their existing non-resuming fast paths. */
static BOOL qjs_generator_can_resume(JSValueConst func_obj, JSValueConst this_obj)
{
    JSObject *p;
    JSGeneratorData *s;
    int magic;
    if (!JS_IsObject(func_obj)) return FALSE;
    p = JS_VALUE_GET_OBJ(func_obj);
    if (p->class_id != JS_CLASS_C_FUNCTION ||
        p->u.cfunc.cproto != JS_CFUNC_iterator_next ||
        p->u.cfunc.c_function.iterator_next != js_generator_next)
        return FALSE;
    magic = p->u.cfunc.magic;
    if (magic < GEN_MAGIC_NEXT || magic > GEN_MAGIC_THROW) return FALSE;
    s = JS_GetOpaque(this_obj, JS_CLASS_GENERATOR);
    if (!s || !s->func_state) return FALSE;
    return (s->state == JS_GENERATOR_STATE_SUSPENDED_START && magic == GEN_MAGIC_NEXT) ||
        s->state == JS_GENERATOR_STATE_SUSPENDED_YIELD ||
        s->state == JS_GENERATOR_STATE_SUSPENDED_YIELD_STAR;
}

static JSAsyncFunctionState *qjs_generator_resume_prepare(JSContext *ctx,
    JSValueConst func_obj, JSValueConst this_obj, int argc, JSValueConst *argv)
{
    JSGeneratorData *s = JS_GetOpaque(this_obj, JS_CLASS_GENERATOR);
    JSAsyncFunctionState *state = s->func_state;
    JSStackFrame *sf = &state->frame;
    int magic = JS_VALUE_GET_OBJ(func_obj)->u.cfunc.magic;
    assert(qjs_generator_can_resume(func_obj, this_obj));
    if (s->state == JS_GENERATOR_STATE_SUSPENDED_START) {
        state->throw_flag = FALSE;
    } else {
        JSValue ret = JS_DupValue(ctx, argc ? argv[0] : JS_UNDEFINED);
        if (magic == GEN_MAGIC_THROW && s->state == JS_GENERATOR_STATE_SUSPENDED_YIELD) {
            JS_Throw(ctx, ret);
            state->throw_flag = TRUE;
        } else {
            sf->cur_sp[-1] = ret;
            sf->cur_sp[0] = JS_NewInt32(ctx, magic);
            sf->cur_sp++;
            state->throw_flag = FALSE;
        }
    }
    s->state = JS_GENERATOR_STATE_EXECUTING;
    return state;
}

static JSValue qjs_generator_resume_finish(JSContext *ctx,
    JSValueConst generator, JSValue func_ret)
{
    JSGeneratorData *s = JS_GetOpaque(generator, JS_CLASS_GENERATOR);
    JSStackFrame *sf = &s->func_state->frame;
    JSValue ret;
    int done = TRUE;
    assert(s->state == JS_GENERATOR_STATE_EXECUTING);
    func_ret = qjs_async_func_resume_complete(ctx, s->func_state, func_ret);
    s->state = JS_GENERATOR_STATE_SUSPENDED_YIELD;
    if (s->func_state->is_completed) {
        free_generator_stack(ctx, s);
        ret = func_ret;
    } else {
        assert(JS_VALUE_GET_TAG(func_ret) == JS_TAG_INT);
        ret = sf->cur_sp[-1];
        sf->cur_sp[-1] = JS_UNDEFINED;
        if (JS_VALUE_GET_INT(func_ret) == FUNC_RET_YIELD_STAR) {
            s->state = JS_GENERATOR_STATE_SUSPENDED_YIELD_STAR;
            done = 2;
        } else {
            done = FALSE;
        }
    }
    if (!JS_IsException(ret) && done != 2)
        ret = js_create_iterator_result(ctx, ret, done);
    return ret;
}

${generatorFunction}`)
  writeFileSync(file,source)
}
