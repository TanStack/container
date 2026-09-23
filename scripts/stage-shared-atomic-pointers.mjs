import {readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'

// Apply after stageAtomicWait. Keep argument conversion and error order intact.
export function stageSharedAtomicPointers(directory){
  const path=join(directory,'quickjs.c')
  let source=readFileSync(path,'utf8')
  const edit=(name,next,change)=>{
    const marker='static JSValue '+name+'(JSContext *ctx,'
    if(source.split(marker).length!==2)throw Error('Unexpected atomic pointer function: '+name)
    const start=source.indexOf(marker),end=source.indexOf(next,start+marker.length)
    if(end<0)throw Error('Missing atomic pointer function boundary: '+name)
    let body=source.slice(start,end)
    const replace=(before,after)=>{
      if(body.split(before).length!==2)throw Error('Unexpected atomic pointer site in '+name+': '+before)
      body=body.replace(before,after)
    }
    change(replace)
    source=source.slice(0,start)+body+source.slice(end)
  }
  const capture=`    /* Keep the validated byte offset, never repeat index coercion. */
    JSObject *shared_array = JS_VALUE_GET_OBJ(argv[0]);
    uintptr_t shared_offset = (uintptr_t)ptr - (uintptr_t)shared_array->u.array.u.uint8_ptr;
`
  const refresh=`    if (abuf->shared)
        ptr = shared_array->u.array.u.uint8_ptr + shared_offset;
`
  edit('js_atomics_op','static JSValue js_atomics_store(',replace=>{
    replace('    rep_val = 0;',capture+'    rep_val = 0;')
    replace('   switch(op | (size_log2 << 3)) {',refresh+'\n   switch(op | (size_log2 << 3)) {')
  })
  edit('js_atomics_store','static JSValue js_atomics_isLockFree(',replace=>{
    replace('    if (size_log2 == 3) {',capture+'    if (size_log2 == 3) {')
    replace('        atomic_store((_Atomic(uint64_t) *)ptr, v64);',refresh+'        atomic_store((_Atomic(uint64_t) *)ptr, v64);')
    replace('        switch(size_log2) {',refresh+'        switch(size_log2) {')
  })
  edit('js_atomics_wait','static JSValue js_atomics_notify(',replace=>{
    replace('    if (size_log2 == 3) {',capture+'    if (size_log2 == 3) {')
    replace('    ret = QTS_FiberAtomicWait(ctx, ptr, size_log2, v, isnan(d) ? INFINITY : d < 0 ? 0 : d);',
      '    ptr = shared_array->u.array.u.uint8_ptr + shared_offset;\n    ret = QTS_FiberAtomicWait(ctx, ptr, size_log2, v, isnan(d) ? INFINITY : d < 0 ? 0 : d);')
  })
  edit('js_atomics_notify','static const JSCFunctionListEntry js_atomics_funcs[]',replace=>{
    replace('    if (JS_IsUndefined(argv[2])) {',capture+'    if (JS_IsUndefined(argv[2])) {')
    replace('    n = abuf->shared ? QTS_FiberAtomicNotify(ptr, count) : 0;',refresh+'    n = abuf->shared ? QTS_FiberAtomicNotify(ptr, count) : 0;')
  })
  writeFileSync(path,source)
}
