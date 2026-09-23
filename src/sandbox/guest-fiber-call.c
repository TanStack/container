/* Experimental QTS_Call/QTS_Eval continuation driver. Appended to interface.c so result
 * ownership matches the regular wrapper. This does not implement WASM threads.
 * The embedding must keep the runtime alive until every task is disposed. */
#include <emscripten/fiber.h>
#ifdef QJS_GUEST_WASM
#include "guest-wasm-fiber.h"
#endif
#ifdef QTS_SHARED_STORAGE
#include <math.h>
#include "guest-shared-storage.h"
#endif

#define QTS_FIBER_STACK_BYTES (512 * 1024)
#define QTS_FIBER_STACK_ALIGNMENT 16
_Static_assert(QTS_FIBER_STACK_BYTES % QTS_FIBER_STACK_ALIGNMENT == 0,
  "Fiber stack size must preserve C stack alignment");
extern void QJS_FiberSaveStack(JSRuntime *rt, uintptr_t *bounds);
extern void QJS_FiberRestoreStack(JSRuntime *rt, const uintptr_t *bounds);
typedef struct QTSFiberCall {
  emscripten_fiber_t fiber;
  emscripten_fiber_t root;
  JSContext *ctx;
  JSValue function, receiver;
  JSValue exception;
  JSValue *result;
  struct QTSFiberCall *next;
  uintptr_t host_bounds[2], fiber_bounds[2];
  void *stack, *continuation, *root_continuation;
  char *source, *filename;
  int eval_flags;
  int status, delivered, value, cancelled, taken, has_exception, started;
#ifdef QJS_GUEST_WASM
  QWasmFiberState wasm_host,wasm_fiber;
#endif
#ifdef QTS_SHARED_STORAGE
  QTSSharedStorage *atomic_storage;
  size_t atomic_offset;
  double atomic_timeout;
  struct QTSFiberCall *atomic_next;
#endif
} QTSFiberCall;

static QTSFiberCall *qts_active_fiber;
static QTSFiberCall *qts_fiber_tasks;

#ifdef QTS_FIBER_FAIRNESS
/* Called only after a bytecode branch's interrupt check has returned. No host
 * callback can remain on the stack when the scheduler receives this pause. */
int QTS_FiberFairnessPause(JSContext *ctx) {
  QTSFiberCall *task=qts_active_fiber;
  if (!task || task->ctx!=ctx || task->status!=0 || qts_fiber_host_callback_depth)
    return 0;
  if (task->cancelled) return 1;
#ifdef QJS_GUEST_WASM
  if (!QWasmFiberCanYield()) return 0;
#endif
  task->status=3;
  emscripten_fiber_swap(&task->fiber,&task->root);
  task->status=0;
  return task->cancelled;
}
#endif

#ifdef QTS_SHARED_STORAGE
/* Waiters are embedded in their fibers. The engine serializes comparison,
 * registration and notification, so no host callbacks or pthread locks occur. */
static QTSFiberCall *qts_atomic_waiters;
static QTSSharedStorage *qts_atomic_storage(void *ptr,size_t width,size_t *offset) {
  return QTS_SharedStorageFind(ptr,width,offset);
}
int QTS_FiberAtomicWait(JSContext *ctx,void *ptr,int size_log2,
                       int64_t expected,double timeout) {
  QTSFiberCall *task=qts_active_fiber;
  if (!task || task->ctx!=ctx || qts_fiber_host_callback_depth) {
    JS_ThrowInternalError(ctx,"Atomic wait requires an owned fiber outside host callbacks"); return -1;
  }
  if (task->cancelled) { JS_ThrowInternalError(ctx,"Fiber call cancelled"); return -1; }
  size_t offset=0;
  const size_t width=size_log2==2?4:size_log2==3?8:0;
  QTSSharedStorage *storage=width?qts_atomic_storage(ptr,width,&offset):NULL;
  if (!storage || (uintptr_t)ptr%width) {
    JS_ThrowTypeError(ctx,"Atomic wait requires registered shared storage"); return -1;
  }
  int64_t current;
  if (width==8)memcpy(&current,ptr,8);
  else {int32_t value;memcpy(&value,ptr,4);current=value;}
  if (current!=expected) return 1;
  if (timeout<=0) return 2;
  if (isnan(timeout))timeout=INFINITY;
  QTS_SharedStorageRetain(storage);
  task->atomic_storage=storage;task->atomic_offset=offset;
  task->atomic_timeout=timeout;task->atomic_next=NULL;
  QTSFiberCall **tail=&qts_atomic_waiters;
  while (*tail)tail=&(*tail)->atomic_next;
  *tail=task;
  task->status=1;task->delivered=0;
  emscripten_fiber_swap(&task->fiber,&task->root);
  QTSFiberCall **link=&qts_atomic_waiters;
  while (*link && *link!=task)link=&(*link)->atomic_next;
  if (*link)*link=task->atomic_next;
  task->atomic_next=NULL;task->atomic_storage=NULL;
  QTS_SharedStorageRelease(storage);
  task->status=0;task->delivered=0;
  if (task->cancelled) { JS_ThrowInternalError(ctx,"Fiber call cancelled"); return -1; }
  return task->value;
}
int QTS_FiberAtomicNotify(void *ptr,int count) {
  if (count<=0)return 0;
  size_t offset=0;
  QTSSharedStorage *storage=qts_atomic_storage(ptr,1,&offset);
  if (!storage)return 0;
  int notified=0;
  for (QTSFiberCall *task=qts_atomic_waiters;task && notified<count;task=task->atomic_next) {
    if (task->atomic_storage==storage && task->atomic_offset==offset &&
        task->status==1 && !task->delivered && !task->cancelled) {
      task->value=0;task->delivered=1;notified++;
    }
  }
  return notified;
}
int QTS_FiberAtomicPending(QTSFiberCall *task) {return task && task->status==1 && task->atomic_storage!=NULL;}
double QTS_FiberAtomicTimeout(QTSFiberCall *task) {return QTS_FiberAtomicPending(task)?task->atomic_timeout:0;}
int QTS_FiberAtomicReady(QTSFiberCall *task) {return QTS_FiberAtomicPending(task) && task->delivered;}
#endif

static JSValue qts_fiber_park(JSContext *ctx, JSValueConst self,
                             int argc, JSValueConst *argv) {
  (void)self; (void)argc; (void)argv;
  QTSFiberCall *task=qts_active_fiber;
  if (!task || task->ctx!=ctx)
    return JS_ThrowInternalError(ctx,"No active owned fiber call");
  if (qts_fiber_host_callback_depth)
    return JS_ThrowInternalError(ctx,"Cannot park across a host callback");
  if (task->cancelled) return JS_ThrowInternalError(ctx,"Fiber call cancelled");
  task->status=1; task->delivered=0;
  emscripten_fiber_swap(&task->fiber,&task->root);
  task->status=0;
  if (task->cancelled) return JS_ThrowInternalError(ctx,"Fiber call cancelled");
  task->delivered=0;
  return JS_NewInt32(ctx,task->value);
}

static void qts_fiber_execute(void *opaque) {
  QTSFiberCall *task=opaque;
  JS_UpdateStackTop(JS_GetRuntime(task->ctx));
  QJS_FiberSaveStack(JS_GetRuntime(task->ctx),task->fiber_bounds);
  task->started=1;
  task->result=task->cancelled
    ? jsvalue_to_heap(JS_ThrowInternalError(task->ctx,"Fiber call cancelled"))
    : task->source
      ? QTS_Eval(task->ctx,task->source,strlen(task->source),task->filename,0,task->eval_flags)
      : QTS_Call(task->ctx,&task->function,&task->receiver,0,NULL);
  if (task->result && JS_IsException(*task->result)) {
    task->exception=JS_GetException(task->ctx);
    task->has_exception=1;
  }
  task->status=2;
  emscripten_fiber_swap(&task->fiber,&task->root);
  abort();
}

static QTSFiberCall *qts_fiber_create(JSContext *ctx) {
  if (qts_active_fiber || !ctx) return NULL;
  for (QTSFiberCall *existing=qts_fiber_tasks;existing;existing=existing->next)
    if (JS_GetRuntime(existing->ctx)==JS_GetRuntime(ctx)) return NULL;
  QTSFiberCall *task=js_mallocz(ctx,sizeof(*task));
  if (!task) return NULL;
  /* The WASM C stack requires 16-byte alignment; js_malloc only guarantees
   * allocator alignment. Keep the original allocation for accounting/free. */
  task->stack=js_malloc(ctx,QTS_FIBER_STACK_BYTES+QTS_FIBER_STACK_ALIGNMENT-1);
  task->continuation=js_malloc(ctx,QTS_FIBER_STACK_BYTES);
  task->root_continuation=js_malloc(ctx,QTS_FIBER_STACK_BYTES);
  if (!task->stack || !task->continuation || !task->root_continuation) {
    js_free(ctx,task->stack); js_free(ctx,task->continuation);
    js_free(ctx,task->root_continuation); js_free(ctx,task); return NULL;
  }
  task->ctx=JS_DupContext(ctx);
  task->function=JS_UNDEFINED;
  task->receiver=JS_UNDEFINED;
  task->exception=JS_UNDEFINED;
#ifdef QJS_GUEST_WASM
  task->wasm_fiber.bridge_helper=JS_UNDEFINED;
#endif
  task->next=qts_fiber_tasks; qts_fiber_tasks=task;
  uintptr_t stack_address=(uintptr_t)task->stack;
  size_t stack_padding=(QTS_FIBER_STACK_ALIGNMENT-
    (stack_address%QTS_FIBER_STACK_ALIGNMENT))%QTS_FIBER_STACK_ALIGNMENT;
  void *aligned_stack=(unsigned char *)task->stack+stack_padding;
  emscripten_fiber_init(&task->fiber,qts_fiber_execute,task,
    aligned_stack,QTS_FIBER_STACK_BYTES,task->continuation,QTS_FIBER_STACK_BYTES);
  return task;
}

QTSFiberCall *QTS_FiberCreate(JSContext *ctx, JSValueConst *function,
                             JSValueConst *receiver) {
  if (qts_active_fiber || !ctx || !function || !receiver || !JS_IsFunction(ctx,*function)) return NULL;
  QTSFiberCall *task=qts_fiber_create(ctx);
  if (!task) return NULL;
  task->function=JS_DupValue(ctx,*function);
  task->receiver=JS_DupValue(ctx,*receiver);
  return task;
}

QTSFiberCall *QTS_FiberCreateEval(JSContext *ctx,const char *source,
                                 const char *filename,int flags) {
  if (qts_active_fiber || !ctx || !source || !filename) return NULL;
  char *owned_source=js_strdup(ctx,source);
  char *owned_filename=js_strdup(ctx,filename);
  if (!owned_source || !owned_filename) {
    js_free(ctx,owned_source); js_free(ctx,owned_filename); return NULL;
  }
  QTSFiberCall *task=qts_fiber_create(ctx);
  if (!task) {
    js_free(ctx,owned_source); js_free(ctx,owned_filename); return NULL;
  }
  task->source=owned_source; task->filename=owned_filename; task->eval_flags=flags;
  return task;
}

void QTS_FiberStep(QTSFiberCall *task) {
  if (!task || qts_active_fiber || task->status==2 ||
      (task->status==1 && !task->delivered && !task->cancelled)) return;
  qts_active_fiber=task;
#ifdef QJS_GUEST_WASM
  QWasmFiberSave(&task->wasm_host);
  QWasmFiberRestore(&task->wasm_fiber);
#endif
  QJS_FiberSaveStack(JS_GetRuntime(task->ctx),task->host_bounds);
  if (task->started) QJS_FiberRestoreStack(JS_GetRuntime(task->ctx),task->fiber_bounds);
  /* A new root continuation belongs to this external step, never a previous
   * JavaScript call whose stack has already returned. */
  emscripten_fiber_init_from_current_context(&task->root,
    task->root_continuation,QTS_FIBER_STACK_BYTES);
  emscripten_fiber_swap(&task->root,&task->fiber);
#ifdef QJS_GUEST_WASM
  QWasmFiberSave(&task->wasm_fiber);
  QWasmFiberRestore(&task->wasm_host);
#endif
  qts_active_fiber=NULL;
  QJS_FiberRestoreStack(JS_GetRuntime(task->ctx),task->host_bounds);
}

int QTS_FiberStatus(QTSFiberCall *task) { return task ? task->status : -1; }
int QTS_FiberDeliver(QTSFiberCall *task,int value) {
  if (!task || qts_active_fiber || task->status!=1 || task->delivered || task->cancelled) return 0;
#ifdef QTS_SHARED_STORAGE
  /* Only native notify can complete an atomic wait successfully. The host may
   * deliver timeout, and cannot overwrite a notification that already won. */
  if (task->atomic_storage && value!=2)return 0;
#endif
  task->value=value; task->delivered=1; return 1;
}
int QTS_FiberCancel(QTSFiberCall *task) {
  if (!task || qts_active_fiber || task->status==2 || task->cancelled) return 0;
  task->cancelled=1; return 1;
}
JSValue *QTS_FiberTakeResult(QTSFiberCall *task) {
  if (!task || qts_active_fiber || task->status!=2 || task->taken) return NULL;
  task->taken=1;
  if (task->has_exception) {
    JS_Throw(task->ctx,task->exception);
    task->exception=JS_UNDEFINED; task->has_exception=0;
  }
  JSValue *result=task->result; task->result=NULL; return result;
}
int QTS_FiberDispose(QTSFiberCall *task) {
  if (!task || qts_active_fiber || task->status!=2 || !task->taken) return 0;
  JSContext *ctx=task->ctx;
  QTSFiberCall **link=&qts_fiber_tasks;
  while (*link && *link!=task) link=&(*link)->next;
  if (*link) *link=task->next;
  JS_FreeValue(ctx,task->function); JS_FreeValue(ctx,task->receiver);
  JS_FreeValue(ctx,task->exception);
  js_free(ctx,task->source); js_free(ctx,task->filename);
  js_free(ctx,task->stack); js_free(ctx,task->continuation);
  js_free(ctx,task->root_continuation); js_free(ctx,task);
  JS_FreeContext(ctx); return 1;
}
JSValue *QTS_InitializeFiber(JSContext *ctx,JSValueConst *initializer) {
  if (qts_active_fiber || !JS_IsFunction(ctx,*initializer))
    return jsvalue_to_heap(JS_ThrowTypeError(ctx,"Expected trusted fiber initializer"));
  JSValue park=JS_NewCFunction(ctx,qts_fiber_park,"park",0);
  if (JS_IsException(park)) return jsvalue_to_heap(park);
  JSValue result=JS_Call(ctx,*initializer,JS_UNDEFINED,1,&park);
  JS_FreeValue(ctx,park);
  return jsvalue_to_heap(result);
}
