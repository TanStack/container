import {readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'

export function stageFiberFairness(directory,interfaceFile){
  const replace=(source,from,to)=>{
    if(source.split(from).length!==2)throw Error('Unexpected fiber fairness source anchor: '+from.slice(0,80))
    return source.replace(from,to)
  }
  const path=join(directory,'quickjs.c')
  let source=readFileSync(path,'utf8')
  const anchor='static void JS_SetImmutablePrototype(JSContext *ctx, JSValueConst obj)'
  source=replace(source,anchor,`extern int QTS_FiberFairnessPause(JSContext *ctx);
/* Only bytecode branches opt into fairness. Other interrupt callers, including
 * native builtins and compilation, retain their original behavior. */
static inline __exception int js_poll_fiber_branch(JSContext *ctx)
{
    if (unlikely(--ctx->interrupt_counter <= 0)) {
        if (__js_poll_interrupts(ctx)) return -1;
        if (QTS_FiberFairnessPause(ctx)) {
            JS_ThrowInterrupted(ctx);
            return -1;
        }
    }
    return 0;
}

`+anchor)
  const start=source.indexOf('        CASE(OP_goto):'),end=source.indexOf('        CASE(OP_catch):',start)
  if(start<0||end<0)throw Error('Missing bytecode branch range')
  const branches=source.slice(start,end)
  if(branches.split('js_poll_interrupts(ctx)').length!==8)throw Error('Expected seven bytecode branch polls')
  source=source.slice(0,start)+branches.replaceAll('js_poll_interrupts(ctx)','js_poll_fiber_branch(ctx)')+source.slice(end)
  let wrapper=readFileSync(interfaceFile,'utf8')
  for(const call of [
    '  char *module_source = qts_host_load_module_source(rt, ctx, module_name);',
    '  char *em_module_name = qts_host_normalize_module(rt, ctx, module_base_name, module_name);',
  ])wrapper=replace(wrapper,call,'  qts_fiber_host_callback_depth++;\n'+call+'\n  qts_fiber_host_callback_depth--;')
  writeFileSync(path,source);writeFileSync(interfaceFile,wrapper)
}
