import {readFileSync,writeFileSync} from 'node:fs'

// Keep QuickJS argument validation and coercion, replace only the blocking backend.
export function stageAtomicWait(filename){
  let source=readFileSync(filename,'utf8')
  const start=source.indexOf('static JSValue js_atomics_wait(JSContext *ctx,')
  const end=source.indexOf('static JSValue js_atomics_notify(JSContext *ctx,',start)
  if(start<0||end<0)throw Error('Missing native atomic wait integration sites')
  const wait=source.slice(start,end),blocking=wait.indexOf('    /* XXX: inefficient if large number of waiters')
  if(blocking<0||!wait.includes('pthread_cond_timedwait'))throw Error('Unexpected native wait backend')
  const replacement=`extern int QTS_FiberAtomicWait(JSContext *, void *, int, int64_t, double);
extern int QTS_FiberAtomicNotify(void *, int);
${wait.slice(0,blocking)}    ret = QTS_FiberAtomicWait(ctx, ptr, size_log2, v, isnan(d) ? INFINITY : d < 0 ? 0 : d);
    if (ret < 0) return JS_EXCEPTION;
    return JS_AtomToString(ctx, ret == 1 ? JS_ATOM_not_equal : ret == 2 ? JS_ATOM_timed_out : JS_ATOM_ok);
}

`
  source=source.slice(0,start)+replacement+source.slice(end)
  const notifyStart=source.indexOf('static JSValue js_atomics_notify(JSContext *ctx,')
  const notifyEnd=source.indexOf('static const JSCFunctionListEntry js_atomics_funcs[]',notifyStart)
  const notify=source.slice(notifyStart,notifyEnd),backend=notify.indexOf('    n = 0;')
  if(backend<0||!notify.includes('pthread_cond_signal'))throw Error('Unexpected native notify backend')
  source=source.slice(0,notifyStart)+notify.slice(0,backend)+`    n = abuf->shared ? QTS_FiberAtomicNotify(ptr, count) : 0;
    return JS_NewInt32(ctx, n);
}

`+source.slice(notifyEnd)
  writeFileSync(filename,source)
}
