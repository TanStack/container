#include "quickjs.h"
#include <emscripten/fiber.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Continuation/lifetime proof only. This is not a WASM threads implementation. */
typedef struct { uint8_t *bytes; int references; } Storage;
typedef struct {
  emscripten_fiber_t fiber;
  JSRuntime *runtime;
  JSContext *context;
  void *stack, *continuation;
  const char *source;
  int parked, finished, failed, cancelled, budget, interrupted, host_ready, host_value, request_id;
} Task;
static emscripten_fiber_t scheduler;
static int released;
static Task *host_requests[16];
static int next_request;
static int host_callbacks,ignored_callbacks;
static void host_complete(void *opaque) {
  int id=(int)(uintptr_t)opaque;host_callbacks++;
  Task *task=host_requests[id];host_requests[id]=NULL;
  if(task){task->host_value=42;task->host_ready=1;}
  else ignored_callbacks++;
}
static JSValue host_read(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv) {
  (void)self;
  Task *task=JS_GetContextOpaque(ctx);
  int32_t delay=10;
  if(argc&&JS_ToInt32(ctx,&delay,argv[0]))return JS_EXCEPTION;
  if(next_request>=16)return JS_ThrowInternalError(ctx,"Host request quota exceeded");
  task->request_id=next_request++;
  host_requests[task->request_id]=task;
#ifndef THREAD_GROUP_DRIVER
  emscripten_async_call(host_complete,(void *)(uintptr_t)task->request_id,delay);
#endif
  task->parked=1;
  emscripten_fiber_swap(&task->fiber,&scheduler);
  if(task->cancelled)return JS_ThrowInternalError(ctx,"Task cancelled");
  if(!task->host_ready)return JS_ThrowInternalError(ctx,"Host read resumed before completion");
  return JS_NewInt32(ctx,task->host_value);
}
static void release_storage(JSRuntime *runtime, void *opaque, void *pointer) {
  (void)runtime; (void)pointer;
  Storage *storage=opaque;
  if (--storage->references==0) { free(storage->bytes); free(storage); released++; }
}
static int interrupt(JSRuntime *runtime,void *opaque) {
  (void)runtime;
  Task *task=opaque;
  if (--task->budget<=0) { task->interrupted=1; return 1; }
  return 0;
}
static JSValue park(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv) {
  (void)self; (void)argc; (void)argv;
  Task *task=JS_GetContextOpaque(ctx);
  task->parked=1;
  emscripten_fiber_swap(&task->fiber,&scheduler);
  if(task->cancelled)return JS_ThrowInternalError(ctx,"Task cancelled");
  return JS_UNDEFINED;
}
static void execute(void *opaque) {
  Task *task=opaque;
  JS_UpdateStackTop(task->runtime);
  JSValue result=JS_Eval(task->context,task->source,strlen(task->source),"fiber.js",JS_EVAL_TYPE_GLOBAL);
  task->failed=JS_IsException(result);
  JS_FreeValue(task->context,result);
  if(task->failed){JSValue error=JS_GetException(task->context);JS_FreeValue(task->context,error);}
  task->finished=1;
  emscripten_fiber_swap(&task->fiber,&scheduler);
  abort();
}
static void init(Task *task,Storage *storage,const char *source) {
  memset(task,0,sizeof(*task)); task->source=source; task->budget=100;
  task->runtime=JS_NewRuntime(); task->context=JS_NewContext(task->runtime);
  JS_SetMemoryLimit(task->runtime,8*1024*1024);
  JS_SetMaxStackSize(task->runtime,256*1024);
  JS_SetInterruptHandler(task->runtime,interrupt,task);
  JS_SetContextOpaque(task->context,task);
  JSValue global=JS_GetGlobalObject(task->context);
  storage->references++;
  JS_SetPropertyStr(task->context,global,"bytes",JS_NewArrayBuffer(task->context,storage->bytes,4,release_storage,storage,0));
  JS_SetPropertyStr(task->context,global,"park",JS_NewCFunction(task->context,park,"park",0));
  JS_SetPropertyStr(task->context,global,"hostRead",JS_NewCFunction(task->context,host_read,"hostRead",0));
  JS_FreeValue(task->context,global);
  task->stack=malloc(512*1024);task->continuation=malloc(512*1024);
  emscripten_fiber_init(&task->fiber,execute,task,task->stack,512*1024,task->continuation,512*1024);
}
static void close_task(Task *task) {
  JS_FreeContext(task->context);JS_FreeRuntime(task->runtime);
  free(task->stack);free(task->continuation);
}
#define CHECK(value) do {if(!(value)){fprintf(stderr,"Failed line %d: %s\n",__LINE__,#value);exit(1);}}while(0)
static void run_case(int cancel,int exhaust) {
  Storage *storage=calloc(1,sizeof(*storage));storage->bytes=calloc(4,1);
  Task a,b;int previous=released;
  init(&a,storage,"const view=new Uint8Array(bytes);view[0]=7;park();if(view[0]!==42)throw Error('peer change missing');view[1]=9;");
  init(&b,storage,exhaust?"const view=new Uint8Array(bytes);if(view[0]!==7)throw Error('initial change missing');view[0]=42;while(true){}":"const view=new Uint8Array(bytes);if(view[0]!==7)throw Error('initial change missing');view[0]=42;");
  emscripten_fiber_swap(&scheduler,&a.fiber);
  CHECK(a.parked&&!a.finished);
  emscripten_fiber_swap(&scheduler,&b.fiber);
  CHECK(b.finished&&b.failed==exhaust&&b.interrupted==exhaust);
  close_task(&b);CHECK(released==previous&&storage->references==1);
  a.cancelled=cancel;
  emscripten_fiber_swap(&scheduler,&a.fiber);
  CHECK(a.finished&&a.failed==cancel&&!a.interrupted);
  CHECK(storage->bytes[1]==(cancel?0:9));
  close_task(&a);CHECK(released==previous+1);
}
static void run_host_case(int cancel) {
  Storage *storage=calloc(1,sizeof(*storage));storage->bytes=calloc(4,1);
  Task a,b;int previous=released,callbacks=host_callbacks,ignored=ignored_callbacks;
  init(&a,storage,"const view=new Uint8Array(bytes);view[0]=7;const result=hostRead();if(result!==42||view[0]!==21)throw Error('host read or peer progress missing');view[1]=9;");
  init(&b,storage,"const view=new Uint8Array(bytes);if(view[0]!==7)throw Error('initial change missing');view[0]=21;");
  emscripten_fiber_swap(&scheduler,&a.fiber);
  CHECK(a.parked&&!a.finished&&!a.host_ready);
  emscripten_fiber_swap(&scheduler,&b.fiber);
  CHECK(b.finished&&!b.failed&&storage->bytes[0]==21);
  close_task(&b);
  if(cancel){
    a.cancelled=1;host_requests[a.request_id]=NULL;
    emscripten_fiber_swap(&scheduler,&a.fiber);
    CHECK(a.finished&&a.failed&&storage->bytes[1]==0);
    close_task(&a);
    /* The callback outlives the cancelled runtime, but carries no guest pointer. */
    while(host_callbacks==callbacks)emscripten_sleep(1);
    CHECK(ignored_callbacks==ignored+1);
  }else{
    while(!a.host_ready)emscripten_sleep(1);
    emscripten_fiber_swap(&scheduler,&a.fiber);
    CHECK(a.finished&&!a.failed&&storage->bytes[1]==9);
    close_task(&a);CHECK(ignored_callbacks==ignored);
  }
  CHECK(host_callbacks==callbacks+1&&released==previous+1);
}
static void run_overlapping_host_case(void) {
  Storage *storage=calloc(1,sizeof(*storage));storage->bytes=calloc(4,1);
  Task a,b;int previous=released,callbacks=host_callbacks;
  init(&a,storage,"const view=new Uint8Array(bytes);const value=hostRead(20);if(value!==42||view[1]!==9)throw Error('wrong completion ordering');view[0]=7;");
  init(&b,storage,"const view=new Uint8Array(bytes);if(hostRead(0)!==42)throw Error('wrong host result');view[1]=9;");
  emscripten_fiber_swap(&scheduler,&a.fiber);
  emscripten_fiber_swap(&scheduler,&b.fiber);
  CHECK(a.parked&&b.parked&&!a.finished&&!b.finished);
  while(!b.host_ready)emscripten_sleep(1);
  emscripten_fiber_swap(&scheduler,&b.fiber);
  CHECK(b.finished&&!b.failed);close_task(&b);
  while(!a.host_ready)emscripten_sleep(1);
  emscripten_fiber_swap(&scheduler,&a.fiber);
  CHECK(a.finished&&!a.failed&&storage->bytes[0]==7);
  close_task(&a);CHECK(host_callbacks==callbacks+2&&released==previous+1);
}
int main(void) {
  void *continuation=malloc(512*1024);
  emscripten_fiber_init_from_current_context(&scheduler,continuation,512*1024);
  run_case(0,0);run_case(1,0);run_case(0,1);
  run_host_case(0);run_host_case(1);
  run_overlapping_host_case();
  free(continuation);
  puts("{\"cases\":6,\"released\":6,\"peerProgress\":true,\"cancellation\":true,\"independentBudget\":true,\"asyncHost\":true,\"lateCompletion\":true,\"overlappingRequests\":true}");
  return 0;
}
