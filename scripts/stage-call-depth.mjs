import {readFileSync,writeFileSync} from 'node:fs'

export const guestCallDepthLimit=192
export const nativeReentryDepthLimit=64

// Linear WASM stack bytes and the browser's native WASM call stack are separate
// resources. Preserve QuickJS's byte limit and bound recursive calls as well.
export function stageCallDepth(file){
  let source=readFileSync(file,'utf8')
  const replace=(from,to)=>{if(source.split(from).length!==2)throw Error('Unexpected call-depth integration site: '+from);source=source.replace(from,to)}
  replace('    struct JSStackFrame *current_stack_frame;', '    struct JSStackFrame *current_stack_frame;\n    uint32_t guest_call_depth;\n    uint32_t native_reentry_depth;')
  const marker='/* argv[] is modified if (flags & JS_CALL_FLAG_COPY_ARGV) = 0. */\nstatic JSValue JS_CallInternal(JSContext *caller_ctx, JSValueConst func_obj,'
  replace(marker,`/* All returns, including throws, release this call's depth. GCC/Clang's
 * cleanup attribute also covers the interpreter's many early return paths. */
typedef struct {
    JSRuntime *runtime;
    BOOL native_reentry;
} QJSCallDepthGuard;
static void qjs_leave_guest_call(QJSCallDepthGuard *guard)
{
    assert(guard->runtime->guest_call_depth > 0);
    guard->runtime->guest_call_depth--;
    if (guard->native_reentry) {
        assert(guard->runtime->native_reentry_depth > 0);
        guard->runtime->native_reentry_depth--;
    }
}

${marker}`)
  replace(`    if (js_poll_interrupts(caller_ctx))
        return JS_EXCEPTION;`, `    if (js_poll_interrupts(caller_ctx))
        return JS_EXCEPTION;
    /* Public calls, constructors and generator/async resumes add native
     * frames beyond direct bytecode calls. */
    BOOL native_reentry = !!(flags & (JS_CALL_FLAG_COPY_ARGV | JS_CALL_FLAG_GENERATOR | JS_CALL_FLAG_CONSTRUCTOR));
    if (unlikely(rt->guest_call_depth >= ${guestCallDepthLimit} ||
                 (native_reentry && rt->native_reentry_depth >= ${nativeReentryDepthLimit})))
        return JS_ThrowStackOverflow(caller_ctx);
    QJSCallDepthGuard call_depth_guard __attribute__((cleanup(qjs_leave_guest_call))) = {rt, native_reentry};
    rt->guest_call_depth++;
    if (native_reentry) rt->native_reentry_depth++;`)
  writeFileSync(file,source)
}
