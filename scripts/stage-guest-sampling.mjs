import {readFileSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'

// Diagnostic-only, applied after interpreter staging. All edits fail closed.
export function stageGuestSampling(path){
  let source=readFileSync(path,'utf8')
  if(source.includes('qjs_guest_sampling'))throw Error('Guest sampling already staged')
  const replace=(before,after,label)=>{
    if(source.split(before).length!==2)throw Error('Unexpected guest sampling '+label+' anchor')
    source=source.replace(before,after)
  }
  const caseName=source.includes('        QJS_LOCALS_CASE(OP_goto):')?'QJS_LOCALS_CASE':'CASE'
  const start=source.indexOf('        '+caseName+'(OP_goto):'),end=source.indexOf('        '+caseName+'(OP_catch):',start)
  if(start<0||end<0)throw Error('Unexpected guest sampling branch range')
  const branches=source.slice(start,end)
  const normalized=branches.replaceAll('QJS_LOCALS_CASE(','CASE(').replaceAll('QJS_LOCALS_BREAK','BREAK').replaceAll('goto qjs_handler_exception;','goto exception;')
  if(createHash('sha256').update(normalized).digest('hex')!=='06572a095230f70217f71f89abc33e13bea7aab4215b5bac55d84bab75d81ecb'||branches.split('js_poll_interrupts(ctx)').length!==8)throw Error('Unexpected guest sampling branch source')
  source=source.slice(0,start)+branches.replaceAll('js_poll_interrupts(ctx)','qjs_guest_sampling_poll(ctx, b, pc)')+source.slice(end)
  replace('struct JSRuntime {',`#ifdef QJS_GUEST_SAMPLING
struct QJSGuestSampling;
static void qjs_guest_sampling_dispose(JSRuntime *rt);
#endif
struct JSRuntime {
#ifdef QJS_GUEST_SAMPLING
    struct QJSGuestSampling *guest_sampling;
#endif`,'runtime')
  replace('void JS_FreeRuntime(JSRuntime *rt)\n{',`void JS_FreeRuntime(JSRuntime *rt)
{
#ifdef QJS_GUEST_SAMPLING
    qjs_guest_sampling_dispose(rt);
#endif`,'runtime disposal')
  replace('#define free(p) free_is_forbidden(p)',`#ifdef QJS_GUEST_SAMPLING
/* Explicit host diagnostic allocation, not charged to the guest GC heap. */
static void qjs_guest_sampling_host_free(void *value) { free(value); }
#endif
#define free(p) free_is_forbidden(p)`,'host diagnostic allocator')
  replace('static inline __exception int js_poll_interrupts(JSContext *ctx)',`#ifdef QJS_GUEST_SAMPLING
static int qjs_guest_sampling_poll(JSContext *, JSFunctionBytecode *, const uint8_t *);
#else
#define qjs_guest_sampling_poll(ctx, b, pc) js_poll_interrupts(ctx)
#endif
static inline __exception int js_poll_interrupts(JSContext *ctx)`,'poll declaration')
  source+='\n'+readFileSync(new URL('../src/sandbox/guest-sampling.c',import.meta.url),'utf8')
  writeFileSync(path,source)
}
