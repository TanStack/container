/* Experimental fixed-length SAB ownership, one registry per outer engine.
 * Backing bytes are group-accounted, never owned by a creator JSRuntime.
 * Native WASM storage can reserve an adjacent header without moving bytes. */
#include "guest-shared-storage.h"
#include <math.h>
#ifdef __EMSCRIPTEN__
/* The pinned dlmalloc provides a nonmoving resize. Failure preserves the old
 * allocation, unlike a moving realloc it cannot hide an old-plus-new peak. */
extern void *realloc_in_place(void *allocation,size_t size);
#endif
#define QTS_SHARED_MAX_BYTES (16u * 1024u * 1024u)
#define QTS_SHARED_SUPPORTED_BYTES (1536u * 1024u * 1024u)
#define QTS_SHARED_MAX_ALLOCATIONS 256u
static size_t qts_shared_max_bytes=QTS_SHARED_MAX_BYTES;
static int qts_shared_configured;
static int qts_shared_reservation, qts_shared_reservation_configured;
int QTS_ConfigureSharedStorageReservation(double enabled){
  if(enabled!=0&&enabled!=1)return 0;
  if(qts_shared_configured||qts_shared_reservation_configured)return enabled==qts_shared_reservation;
  qts_shared_reservation=(int)enabled;qts_shared_reservation_configured=1;
  return 1;
}
int QTS_ConfigureSharedStorage(double maxBytes){
  if(!isfinite(maxBytes)||maxBytes<65536||maxBytes>QTS_SHARED_SUPPORTED_BYTES||floor(maxBytes)!=maxBytes)return 0;
  const size_t value=(size_t)maxBytes;
  if(qts_shared_configured)return value==qts_shared_max_bytes;
  qts_shared_max_bytes=value;qts_shared_configured=1;
  return 1;
}
struct QTSSharedStorage {
  struct QTSSharedStorage *next;
  uint8_t *bytes;
  void *allocation;
  void *header;
  size_t size, capacity, maxSize, charged, references;
  int reserve;
};
static QTSSharedStorage *qts_shared_storage;
static size_t qts_shared_bytes, qts_shared_allocations, qts_shared_freed;
static size_t qts_shared_growths, qts_shared_peak_bytes;
typedef struct QTSSharedLease {
  struct QTSSharedLease *next;
  QTSSharedStorage *storage;
  size_t length;
  int id;
} QTSSharedLease;
static QTSSharedLease *qts_shared_leases;
static unsigned qts_shared_next_lease, qts_shared_lease_count;
#define QTS_SHARED_MAX_LEASES 1024u
extern int QJS_FixedSharedBuffer(JSContext *ctx,JSValueConst value,
                                 uint8_t **bytes,size_t *length);

static QTSSharedStorage *qts_shared_find(void *bytes) {
  for (QTSSharedStorage *storage=qts_shared_storage;storage;storage=storage->next)
    if (storage->bytes==bytes) return storage;
  return NULL;
}
static size_t qts_shared_target(size_t size,size_t maximum,size_t available,int reserve){
  if(!reserve||!size)return size?size:1;
  size_t limit=maximum<available?maximum:available;
  size_t extra=size/8+(size%8!=0);
  size_t target=extra>SIZE_MAX-size?SIZE_MAX:size+extra;
  if(target<=SIZE_MAX-65535)target=(target+65535)&~(size_t)65535;
  if(target>limit)target=limit&~(size_t)65535;
  return target>size?target:size;
}
static QTSSharedStorage *qts_shared_create(size_t size,size_t prefix,size_t header,size_t maximum,int reserve) {
  if(size>maximum)return NULL;
  if (prefix>SIZE_MAX-size) return NULL;
  size_t payload=size+prefix;
  /* A zero-page separated memory still needs a distinct payload identity. */
  if (!payload && header) payload=1;
  if (!payload || header>SIZE_MAX-payload || qts_shared_allocations>=QTS_SHARED_MAX_ALLOCATIONS ||
      qts_shared_bytes>qts_shared_max_bytes||payload+header>qts_shared_max_bytes-qts_shared_bytes) return NULL;
  QTSSharedStorage *storage=malloc(sizeof(*storage));
  if (!storage) return NULL;
  const size_t exact=payload;
  if(reserve)payload=qts_shared_target(size,maximum,qts_shared_max_bytes-qts_shared_bytes-header,1);
  storage->allocation=calloc(1,payload);
  if(!storage->allocation&&payload!=exact){payload=exact;storage->allocation=calloc(1,payload);}
  if (!storage->allocation) { free(storage); return NULL; }
  storage->header=header?calloc(1,header):NULL;
  if (header&&!storage->header) { free(storage->allocation);free(storage);return NULL; }
  storage->bytes=(uint8_t *)storage->allocation+prefix;
  storage->size=size;storage->capacity=payload;storage->maxSize=maximum;storage->reserve=reserve;
  storage->charged=payload+header;storage->references=1;
  storage->next=qts_shared_storage; qts_shared_storage=storage;
  qts_shared_bytes+=storage->charged; qts_shared_allocations++;
  if(qts_shared_bytes>qts_shared_peak_bytes)qts_shared_peak_bytes=qts_shared_bytes;
  return storage;
}
QTSSharedStorage *QTS_SharedStorageCreate(size_t size,size_t prefix){return qts_shared_create(size,prefix,0,SIZE_MAX,0);}
QTSSharedStorage *QTS_SharedStorageCreateWithHeader(size_t size,size_t header){return qts_shared_create(size,0,header,SIZE_MAX,0);}
QTSSharedStorage *QTS_SharedStorageCreateWithHeaderMax(size_t size,size_t header,size_t maximum){return qts_shared_create(size,0,header,maximum,qts_shared_reservation);}
void *QTS_SharedStorageHeader(const QTSSharedStorage *storage){return storage?storage->header:NULL;}
void *QTS_SharedStorageData(const QTSSharedStorage *storage){return storage?storage->bytes:NULL;}
size_t QTS_SharedStorageCapacity(const QTSSharedStorage *storage){return storage?storage->size:0;}
size_t QTS_SharedStorageAllocatedCapacity(const QTSSharedStorage *storage){return storage?storage->capacity:0;}
int QTS_SharedStorageGrow(QTSSharedStorage *storage,size_t size){
  if(!storage||!storage->header||size<storage->size||size>storage->maxSize)return 0;
  if(size==storage->size)return 1;
  if(size<=storage->capacity){
    memset(storage->bytes+storage->size,0,size-storage->size);
    storage->size=size;qts_shared_growths++;return 1;
  }
  const size_t exact=size?size:1,oldPayload=storage->capacity;
  size_t payload=exact;
#ifdef __EMSCRIPTEN__
  const size_t delta=payload-oldPayload;
  if(qts_shared_bytes>qts_shared_max_bytes||delta>qts_shared_max_bytes-qts_shared_bytes)return 0;
  payload=qts_shared_target(size,storage->maxSize,qts_shared_max_bytes-qts_shared_bytes+oldPayload,storage->reserve);
  void *in_place=realloc_in_place(storage->allocation,payload);
  if(!in_place&&payload!=exact){payload=exact;in_place=realloc_in_place(storage->allocation,payload);}
  if(in_place){
    /* Publish the logical length only after all newly exposed bytes are zero.
     * The address, storage identity, header and existing view lengths stay put. */
    memset(storage->bytes+storage->size,0,size-storage->size);
    qts_shared_bytes+=payload-oldPayload;
    if(qts_shared_bytes>qts_shared_peak_bytes)qts_shared_peak_bytes=qts_shared_bytes;
    storage->charged+=payload-oldPayload;storage->capacity=payload;storage->size=size;qts_shared_growths++;
    return 1;
  }
#endif
  payload=exact;
  if(qts_shared_bytes>qts_shared_max_bytes||payload>qts_shared_max_bytes-qts_shared_bytes)return 0;
  payload=qts_shared_target(size,storage->maxSize,qts_shared_max_bytes-qts_shared_bytes,storage->reserve);
  void *next=calloc(1,payload);
  if(!next&&payload!=exact){payload=exact;next=calloc(1,payload);}
  if(!next)return 0;
  memcpy(next,storage->bytes,storage->size);
  /* No guest calls or yielding between commit, view refresh and old release. */
  void *previous=storage->allocation;
  qts_shared_bytes+=payload;
  if(qts_shared_bytes>qts_shared_peak_bytes)qts_shared_peak_bytes=qts_shared_bytes;
  storage->allocation=next;storage->bytes=next;storage->size=size;storage->capacity=payload;
  storage->charged+=payload-oldPayload;
  QJS_SharedRefreshViews(storage);
  free(previous);qts_shared_bytes-=oldPayload;qts_shared_growths++;
  return 1;
}
QTSSharedStorage *QTS_SharedStorageFind(void *ptr,size_t width,size_t *offset){
  const uintptr_t address=(uintptr_t)ptr;
  for(QTSSharedStorage *storage=qts_shared_storage;storage;storage=storage->next){
    const uintptr_t base=(uintptr_t)storage->bytes;
    if(address>=base&&address-base<=storage->size&&width<=storage->size-(address-base)){
      if(offset)*offset=(size_t)(address-base);
      return storage;
    }
  }
  return NULL;
}
QTSSharedStorage *QTS_SharedStorageAcquire(void *ptr,size_t width,size_t *offset){
  QTSSharedStorage *storage=QTS_SharedStorageFind(ptr,width,offset);
  if(storage)QTS_SharedStorageRetain(storage);
  return storage;
}
void *QTS_SharedAllocate(size_t size,size_t prefix){return QTS_SharedStorageData(QTS_SharedStorageCreate(size,prefix));}
static void *qts_shared_alloc(void *opaque,size_t size) {(void)opaque;return QTS_SharedAllocate(size,0);}
void QTS_SharedStorageRetain(QTSSharedStorage *storage) {
  /* These callbacks are only reached with engine-owned buffers. Their API has
   * no error return, so an invalid native ownership transition is fatal. */
  if (!storage || storage->references==SIZE_MAX) abort();
  storage->references++;
}
void QTS_SharedStorageRelease(QTSSharedStorage *storage) {
  QTSSharedStorage **link=&qts_shared_storage;
  while (*link && *link!=storage) link=&(*link)->next;
  if (!*link || !(*link)->references) abort();
  if (--storage->references) return;
  *link=storage->next;
  qts_shared_bytes-=storage->charged; qts_shared_allocations--; qts_shared_freed++;
  free(storage->header); free(storage->allocation); free(storage);
}
static void qts_shared_dup(void *opaque,void *bytes){(void)opaque;QTS_SharedStorageRetain(qts_shared_find(bytes));}
static void qts_shared_free(void *opaque,void *bytes){(void)opaque;QTS_SharedStorageRelease(qts_shared_find(bytes));}
void QTS_SharedRetainBytes(void *bytes){qts_shared_dup(NULL,bytes);}
void QTS_SharedReleaseBytes(void *bytes){qts_shared_free(NULL,bytes);}
static void qts_install_shared_storage(JSRuntime *runtime) {
  qts_shared_configured=1;
  const JSSharedArrayBufferFunctions callbacks={
    .sab_alloc=qts_shared_alloc,.sab_free=qts_shared_free,
    .sab_dup=qts_shared_dup,.sab_opaque=NULL,
  };
  JS_SetSharedArrayBufferFunctions(runtime,&callbacks);
  JS_SetCanBlock(runtime,1);
}
JSValue *QTS_SharedClone(JSContext *destination,JSContext *source,JSValueConst *value) {
  uint8_t *bytes=NULL; size_t length=0;
  if (!QJS_FixedSharedBuffer(source,*value,&bytes,&length))
    return jsvalue_to_heap(JS_ThrowTypeError(destination,"Expected a fixed-length SharedArrayBuffer"));
  QTSSharedStorage *storage=qts_shared_find(bytes);
  if (!storage || length>storage->size)
    return jsvalue_to_heap(JS_ThrowTypeError(destination,"Shared storage does not belong to this engine"));
  /* Successful adoption invokes sab_dup once. Failed object allocation has
   * not acquired a storage reference, so no manual rollback is needed. */
  /* WASM SAB clones expose the backing memory's current length at adoption.
     Already-existing wrappers keep their original visible lengths. */
  return jsvalue_to_heap(JS_NewArrayBuffer(destination,bytes,storage->header?storage->size:length,NULL,NULL,1));
}
/* Queued host messages own a lease, not a creator runtime or a guest handle. */
JSValue *QTS_SharedRetain(JSContext *ctx,JSValueConst *value) {
  uint8_t *bytes=NULL;size_t length=0;
  if(!QJS_FixedSharedBuffer(ctx,*value,&bytes,&length))
    return jsvalue_to_heap(JS_ThrowTypeError(ctx,"Expected a fixed-length SharedArrayBuffer"));
  QTSSharedStorage *storage=qts_shared_find(bytes);
  if(!storage||length>storage->size)
    return jsvalue_to_heap(JS_ThrowTypeError(ctx,"Shared storage does not belong to this engine"));
  if(qts_shared_lease_count>=QTS_SHARED_MAX_LEASES||qts_shared_next_lease>=2147483647u)
    return jsvalue_to_heap(JS_ThrowRangeError(ctx,"Shared message lease limit reached"));
  QTSSharedLease *lease=malloc(sizeof(*lease));
  if(!lease)return jsvalue_to_heap(JS_ThrowOutOfMemory(ctx));
  lease->storage=storage;lease->length=length;lease->id=(int)++qts_shared_next_lease;
  lease->next=qts_shared_leases;qts_shared_leases=lease;qts_shared_lease_count++;
  QTS_SharedStorageRetain(storage);
  return jsvalue_to_heap(JS_NewInt32(ctx,lease->id));
}
int QTS_SharedRelease(int id) {
  QTSSharedLease **link=&qts_shared_leases;
  while(*link&&(*link)->id!=id)link=&(*link)->next;
  if(!*link)return 0;
  QTSSharedLease *lease=*link;*link=lease->next;qts_shared_lease_count--;
  QTS_SharedStorageRelease(lease->storage);free(lease);return 1;
}
JSValue *QTS_SharedAdopt(JSContext *ctx,int id) {
  QTSSharedLease *lease=qts_shared_leases;
  while(lease&&lease->id!=id)lease=lease->next;
  if(!lease)return jsvalue_to_heap(JS_ThrowTypeError(ctx,"Shared message lease is no longer available"));
  QTSSharedStorage *storage=lease->storage;
  JSValue result=JS_NewArrayBuffer(ctx,storage->bytes,storage->header?storage->size:lease->length,NULL,NULL,1);
  /* Failed adoption keeps the message reference available for cleanup/retry. */
  if(!JS_IsException(result))QTS_SharedRelease(id);
  return jsvalue_to_heap(result);
}
JSValue *QTS_SharedStats(JSContext *ctx) {
  JSValue result=JS_NewObject(ctx);
  if (JS_IsException(result)) return jsvalue_to_heap(result);
  size_t references=0;
  for (QTSSharedStorage *storage=qts_shared_storage;storage;storage=storage->next)
    references+=storage->references;
  const struct {const char *name;size_t value;} fields[]={
    {"bytes",qts_shared_bytes},{"allocations",qts_shared_allocations},
    {"references",references},{"freed",qts_shared_freed},
    {"wrappers",QJS_SharedWrapperCount()},
    {"growths",qts_shared_growths},{"peakBytes",qts_shared_peak_bytes},
    {"maxBytes",qts_shared_max_bytes},{"maxSupportedBytes",QTS_SHARED_SUPPORTED_BYTES},
    {"growthReservation",qts_shared_reservation},
    {"configured",qts_shared_configured},{"maxAllocations",QTS_SHARED_MAX_ALLOCATIONS},
    {"leases",qts_shared_lease_count},{"maxLeases",QTS_SHARED_MAX_LEASES},
  };
  for (size_t i=0;i<sizeof(fields)/sizeof(fields[0]);i++)
    if (JS_SetPropertyStr(ctx,result,fields[i].name,JS_NewFloat64(ctx,(double)fields[i].value))<0) {
      JS_FreeValue(ctx,result); return jsvalue_to_heap(JS_EXCEPTION);
    }
  return jsvalue_to_heap(result);
}
