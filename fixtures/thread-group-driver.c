/* Exports the proven fiber boundary to a JavaScript-owned scheduler. */
#define THREAD_GROUP_DRIVER
#define main baseline_main
#include "thread-group-fibers.c"
#undef main

static Storage *group_storage;
static void *scheduler_stack;
static int live_tasks,entering;
EMSCRIPTEN_KEEPALIVE Task *group_create(const char *source) {
  if(!group_storage){
    group_storage=calloc(1,sizeof(*group_storage));
    group_storage->bytes=calloc(4,1);group_storage->references=1;
    scheduler_stack=malloc(512*1024);
  }
  Task *task=calloc(1,sizeof(*task));
  init(task,group_storage,strdup(source));live_tasks++;
  return task;
}
EMSCRIPTEN_KEEPALIVE int group_step(Task *task) {
  if(entering||task->finished)return -1;
  entering=1;
  emscripten_fiber_init_from_current_context(&scheduler,scheduler_stack,512*1024);
  emscripten_fiber_swap(&scheduler,&task->fiber);
  entering=0;
  return task->finished?(task->failed?3:2):1;
}
EMSCRIPTEN_KEEPALIVE int group_request(Task *task) {return task->request_id;}
/* Fiber trampolines do not propagate the resumed export's return value.
 * Read persisted state after the step call has returned to JavaScript. */
EMSCRIPTEN_KEEPALIVE int group_status(Task *task) {
  if(entering)return -1;
  return task->finished?(task->failed?3:2):task->parked?1:0;
}
EMSCRIPTEN_KEEPALIVE int group_deliver(Task *task,int request,int value) {
  if(task->finished||task->cancelled||task->request_id!=request||host_requests[request]!=task)return 0;
  host_requests[request]=NULL;task->host_ready=1;task->host_value=value;return 1;
}
EMSCRIPTEN_KEEPALIVE void group_cancel(Task *task) {
  task->cancelled=1;
  if(host_requests[task->request_id]==task)host_requests[task->request_id]=NULL;
}
EMSCRIPTEN_KEEPALIVE int group_close(Task *task) {
  if(entering||!task->finished)return 0;
  const char *source=task->source;close_task(task);free((void *)source);free(task);live_tasks--;return 1;
}
EMSCRIPTEN_KEEPALIVE int group_shutdown(void) {
  if(entering||live_tasks)return 0;
  release_storage(NULL,group_storage,NULL);group_storage=NULL;
  free(scheduler_stack);scheduler_stack=NULL;return 1;
}
