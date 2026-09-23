import {readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'

// Track wrappers without changing allocation, visible lengths, or ownership.
export function stageSharedBufferViews(directory){
  const path=join(directory,'quickjs.c')
  let source=readFileSync(path,'utf8')
  const replace=(before,after)=>{
    if(source.split(before).length!==2)throw Error('Unexpected shared buffer view integration site: '+before.slice(0,100))
    source=source.replace(before,after)
  }
  replace('#include "quickjs.h"','#include "quickjs.h"\n#include "guest-shared-storage.h"')
  replace('typedef struct JSArrayBuffer {',`typedef struct JSArrayBuffer {
    QTSSharedStorage *shared_storage;
    struct JSArrayBuffer *shared_prev, *shared_next;`)
  replace('} JSArrayBuffer;',`} JSArrayBuffer;
static JSArrayBuffer *qjs_shared_wrappers;`)
  replace('    abuf->free_func = free_func;',`    abuf->free_func = free_func;
    abuf->shared_storage = NULL;
    abuf->shared_prev = abuf->shared_next = NULL;
    if (abuf->shared) {
        QTSSharedStorage *storage = QTS_SharedStorageFind(abuf->data, abuf->byte_length, NULL);
        /* SAB callbacks own the backing reference; this list only borrows it.
           Registered SAB wrappers always start at the backing payload base. */
        if (storage && QTS_SharedStorageData(storage) == abuf->data) {
            abuf->shared_storage = storage;
            abuf->shared_next = qjs_shared_wrappers;
            if (qjs_shared_wrappers) qjs_shared_wrappers->shared_prev = abuf;
            qjs_shared_wrappers = abuf;
        }
    }`)
  replace('        if (abuf->shared && rt->sab_funcs.sab_free) {',`        if (abuf->shared_storage) {
            if (abuf->shared_prev) abuf->shared_prev->shared_next = abuf->shared_next;
            else qjs_shared_wrappers = abuf->shared_next;
            if (abuf->shared_next) abuf->shared_next->shared_prev = abuf->shared_prev;
            abuf->shared_storage = NULL;
            abuf->shared_prev = abuf->shared_next = NULL;
        }
        if (abuf->shared && rt->sab_funcs.sab_free) {`)
  source+=`
/* Called only during synchronous storage commit, with no guest reentry. */
size_t QJS_SharedWrapperCount(void) {
    size_t count = 0;
    for (JSArrayBuffer *abuf = qjs_shared_wrappers; abuf; abuf = abuf->shared_next) count++;
    return count;
}
void QJS_SharedRefreshViews(QTSSharedStorage *storage) {
    if (!storage) return;
    for (JSArrayBuffer *abuf = qjs_shared_wrappers; abuf; abuf = abuf->shared_next) {
        if (abuf->shared_storage != storage) continue;
        abuf->data = QTS_SharedStorageData(storage);
        js_array_buffer_update_typed_arrays(abuf);
    }
}
`
  writeFileSync(path,source)
}
