#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef void JSContext;
typedef uintptr_t JSValueConst;
typedef struct { void *pointer; size_t size, capacity; } Allocation;
static Allocation allocations[32];
static int permit_in_place, fail_calloc, resize_calls, refresh_calls;
static size_t live_allocations;
static size_t fail_calloc_above;
static int malloc_calls,calloc_calls;
static Allocation *lookup(void *pointer) {
  for(size_t i=0;i<32;i++)if(allocations[i].pointer==pointer)return &allocations[i];
  assert(!"unknown allocation");return NULL;
}
static void *mock_malloc(size_t size) {
  assert(size<512*1024);malloc_calls++;
  for(size_t i=0;i<32;i++)if(!allocations[i].pointer){
    size_t capacity=size<4096?4096:size;
    void *pointer=malloc(capacity);assert(pointer);
    memset(pointer,0xa5,capacity);
    allocations[i]=(Allocation){pointer,size,capacity};live_allocations++;return pointer;
  }
  assert(!"fixture allocation slots exceeded");return NULL;
}
static void *mock_calloc(size_t count,size_t size) {
  calloc_calls++;
  if(fail_calloc)return NULL;
  assert(!count||size<=SIZE_MAX/count);
  if(fail_calloc_above&&count*size>fail_calloc_above)return NULL;
  void *pointer=mock_malloc(count*size);memset(pointer,0,count*size);return pointer;
}
static void mock_free(void *pointer) {
  if(!pointer)return;
  Allocation *allocation=lookup(pointer);free(pointer);memset(allocation,0,sizeof(*allocation));live_allocations--;
}
static void *mock_resize(void *pointer,size_t size) {
  resize_calls++;
  Allocation *allocation=lookup(pointer);
  if(!permit_in_place||size>allocation->capacity)return NULL;
  allocation->size=size;return pointer;
}
#define malloc mock_malloc
#define calloc mock_calloc
#define free mock_free
#define realloc_in_place mock_resize
#define __EMSCRIPTEN__ 1
/* The runner extracts the unchanged storage implementation before JS wrappers. */
#include "shared-storage-under-test.c"
#undef malloc
#undef calloc
#undef free

void QJS_SharedRefreshViews(QTSSharedStorage *storage) { assert(storage);refresh_calls++; }
static void clean(QTSSharedStorage *storage,QTSSharedStorage *filler) {
  QTS_SharedStorageRelease(storage);
  if(filler)QTS_SharedStorageRelease(filler);
  assert(qts_shared_bytes==0&&qts_shared_allocations==0&&qts_shared_storage==NULL);
  assert(live_allocations==0);
}
static void check_bytes(QTSSharedStorage *storage,size_t old_size,size_t size) {
  unsigned char *bytes=QTS_SharedStorageData(storage);
  for(size_t i=0;i<old_size;i++)assert(bytes[i]==73);
  for(size_t i=old_size;i<size;i++)assert(bytes[i]==0);
}
static void reservation_cases(void) {
  const size_t page=65536;
  assert(QTS_ConfigureSharedStorageReservation(1));
  assert(QTS_ConfigureSharedStorageReservation(1));
  assert(!QTS_ConfigureSharedStorageReservation(0));
  assert(QTS_ConfigureSharedStorage(4*page));
  QTSSharedStorage *storage=QTS_SharedStorageCreateWithHeaderMax(page,16,4*page);
  assert(storage&&QTS_SharedStorageCapacity(storage)==page);
  assert(QTS_SharedStorageAllocatedCapacity(storage)==2*page);
  assert(storage->charged==2*page+16&&qts_shared_bytes==2*page+16);
  unsigned char *original=storage->bytes;void *header=storage->header;
  size_t offset=SIZE_MAX;
  assert(QTS_SharedStorageFind(original+page-1,1,&offset)==storage&&offset==page-1);
  assert(QTS_SharedStorageFind(original+page,1,NULL)==NULL);
  memset(original,73,page);
  // Poison unused physical capacity to prove growth explicitly zeroes it.
  memset(original+page,0xa5,page);
  int allocations_before=malloc_calls,calloc_before=calloc_calls,resize_before=resize_calls;
  assert(QTS_SharedStorageGrow(storage,2*page));
  assert(storage->bytes==original&&storage->header==header&&qts_shared_bytes==2*page+16);
  assert(malloc_calls==allocations_before&&calloc_calls==calloc_before&&resize_calls==resize_before&&refresh_calls==0);
  check_bytes(storage,page,2*page);
  assert(QTS_SharedStorageFind(original+page,1,NULL)==storage);
  // The declared maximum remains an independent bound, not physical capacity.
  assert(!QTS_SharedStorageGrow(storage,4*page+1));
  assert(storage->size==2*page&&storage->bytes==original&&qts_shared_bytes==2*page+16);
  assert(malloc_calls==allocations_before&&resize_calls==resize_before);
  clean(storage,NULL);

  // Reservation failure falls back to the exact requested allocation.
  fail_calloc_above=page;
  storage=QTS_SharedStorageCreateWithHeaderMax(page,16,4*page);
  assert(storage&&QTS_SharedStorageAllocatedCapacity(storage)==page);
  assert(storage->charged==page+16&&qts_shared_bytes==page+16);
  memset(storage->bytes,73,page);original=storage->bytes;header=storage->header;
  size_t before=qts_shared_bytes,live=live_allocations,growths=qts_shared_growths;
  permit_in_place=0;
  assert(!QTS_SharedStorageGrow(storage,2*page));
  assert(storage->size==page&&storage->bytes==original&&storage->header==header);
  assert(QTS_SharedStorageAllocatedCapacity(storage)==page&&qts_shared_bytes==before&&live_allocations==live&&qts_shared_growths==growths);
  check_bytes(storage,page,page);
  fail_calloc_above=2*page;
  assert(QTS_SharedStorageGrow(storage,2*page));
  assert(QTS_SharedStorageAllocatedCapacity(storage)==2*page&&qts_shared_bytes==2*page+16);
  assert(storage->header==header);check_bytes(storage,page,2*page);clean(storage,NULL);
  fail_calloc_above=0;

  // Maximum clipping and zero-page identity do not expose reserved bytes.
  storage=QTS_SharedStorageCreateWithHeaderMax(page,16,page);
  assert(storage&&QTS_SharedStorageAllocatedCapacity(storage)==page);
  assert(!QTS_SharedStorageGrow(storage,page+1));clean(storage,NULL);
  storage=QTS_SharedStorageCreateWithHeaderMax(0,16,page);
  assert(storage&&QTS_SharedStorageCapacity(storage)==0&&QTS_SharedStorageAllocatedCapacity(storage)==1);
  assert(qts_shared_bytes==17);clean(storage,NULL);
  puts("shared storage reservation: physical charge, logical bounds, zeroing, exact fallback, max, and cleanup passed");
}
int main(int argc,char **argv) {
  if(argc==2&&strcmp(argv[1],"reservation")==0){reservation_cases();return 0;}
  assert(QTS_ConfigureSharedStorage(65536));
  // In-place growth fits the final budget but not a simultaneous copy.
  QTSSharedStorage *storage=QTS_SharedStorageCreateWithHeader(1024,16);
  QTSSharedStorage *filler=QTS_SharedStorageCreate(65536-2048-16,0);
  assert(storage&&filler);memset(storage->bytes,73,1024);
  void *original=storage->bytes,*header=storage->header;
  permit_in_place=1;
  assert(QTS_SharedStorageGrow(storage,2048));
  assert(storage->bytes==original&&storage->header==header&&storage->charged==2064);
  assert(qts_shared_bytes==65536&&qts_shared_peak_bytes==65536&&refresh_calls==0);
  check_bytes(storage,1024,2048);clean(storage,filler);

  // A refused nonmoving resize falls back to an independently charged copy.
  storage=QTS_SharedStorageCreateWithHeader(1024,16);assert(storage);
  memset(storage->bytes,73,1024);original=storage->bytes;header=storage->header;
  permit_in_place=0;qts_shared_peak_bytes=qts_shared_bytes;
  assert(QTS_SharedStorageGrow(storage,2048));
  assert(storage->bytes!=original&&storage->header==header&&refresh_calls==1);
  assert(qts_shared_bytes==2064&&qts_shared_peak_bytes==3088&&storage->charged==2064);
  check_bytes(storage,1024,2048);clean(storage,NULL);

  // Copy peak rejection does not publish partial state or ownership changes.
  storage=QTS_SharedStorageCreateWithHeader(1024,16);
  filler=QTS_SharedStorageCreate(65536-2048-16,0);
  memset(storage->bytes,73,1024);original=storage->bytes;header=storage->header;
  size_t before=qts_shared_bytes,growths=qts_shared_growths,live=live_allocations;
  assert(!QTS_SharedStorageGrow(storage,2048));
  assert(storage->bytes==original&&storage->header==header&&storage->size==1024&&storage->charged==1040);
  assert(qts_shared_bytes==before&&qts_shared_growths==growths&&live_allocations==live&&refresh_calls==1);
  check_bytes(storage,1024,1024);
  // Final-size rejection must not even attempt the allocator.
  int calls=resize_calls;permit_in_place=1;
  assert(!QTS_SharedStorageGrow(storage,2049));assert(resize_calls==calls);
  clean(storage,filler);

  // Deterministic allocator failure, not memory exhaustion, preserves state.
  storage=QTS_SharedStorageCreateWithHeader(1024,16);memset(storage->bytes,73,1024);
  original=storage->bytes;before=qts_shared_bytes;live=live_allocations;
  permit_in_place=0;fail_calloc=1;
  assert(!QTS_SharedStorageGrow(storage,2048));
  assert(storage->bytes==original&&storage->size==1024&&qts_shared_bytes==before&&live_allocations==live);
  check_bytes(storage,1024,1024);
  fail_calloc=0;assert(QTS_SharedStorageGrow(storage,2048));check_bytes(storage,1024,2048);
  clean(storage,NULL);
  // Zero logical length still owns one physical byte, not a full new charge.
  storage=QTS_SharedStorageCreateWithHeader(0,16);assert(storage);
  original=storage->bytes;header=storage->header;permit_in_place=1;
  assert(qts_shared_bytes==17&&storage->charged==17);
  calls=resize_calls;
  assert(QTS_SharedStorageGrow(storage,0)&&resize_calls==calls);
  assert(QTS_SharedStorageGrow(storage,32));
  assert(storage->bytes==original&&storage->header==header);
  assert(storage->size==32&&storage->charged==48&&qts_shared_bytes==48);
  check_bytes(storage,0,32);clean(storage,NULL);
  puts("shared storage growth: in-place, copy, budget rollback, allocator rollback, and cleanup passed");
}
