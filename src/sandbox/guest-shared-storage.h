#ifndef QTS_SHARED_STORAGE_H
#define QTS_SHARED_STORAGE_H
#include <stddef.h>
typedef struct QTSSharedStorage QTSSharedStorage;
/* Host-only policy. First configuration or runtime installation freezes it.
 * Repeating the same value succeeds; invalid or different values return zero. */
int QTS_ConfigureSharedStorage(double maxBytes);
/* Call before byte-budget configuration/runtime installation. Immutable 0/1. */
int QTS_ConfigureSharedStorageReservation(double enabled);
/* Create/acquire return owned references; find returns a borrowed reference.
 * Queries require a live reference. Identity remains stable for its lifetime. */
QTSSharedStorage *QTS_SharedStorageCreate(size_t capacity,size_t prefixBytes);
/* Separate stable header, charged to the same group and freed with storage. */
QTSSharedStorage *QTS_SharedStorageCreateWithHeader(size_t capacity,size_t headerBytes);
/* Opt-in reservation is bounded by maximumBytes and fully group-accounted. */
QTSSharedStorage *QTS_SharedStorageCreateWithHeaderMax(size_t size,size_t headerBytes,size_t maximumBytes);
void *QTS_SharedStorageHeader(const QTSSharedStorage *storage);
/* Separated-header storage only. Failed growth leaves storage unchanged.
 * Nonmoving growth charges the added payload bytes. Moving growth requires
 * the full temporary old+new payload peak to fit the existing group budget. */
int QTS_SharedStorageGrow(QTSSharedStorage *storage,size_t capacity);
QTSSharedStorage *QTS_SharedStorageFind(void *address,size_t width,size_t *offset);
QTSSharedStorage *QTS_SharedStorageAcquire(void *address,size_t width,size_t *offset);
void QTS_SharedStorageRetain(QTSSharedStorage *storage);
void QTS_SharedStorageRelease(QTSSharedStorage *storage);
void *QTS_SharedStorageData(const QTSSharedStorage *storage);
size_t QTS_SharedStorageCapacity(const QTSSharedStorage *storage);
/* Capacity above is the visible length. This query includes unused reserve. */
size_t QTS_SharedStorageAllocatedCapacity(const QTSSharedStorage *storage);
/* QuickJS wrapper bookkeeping, no ownership reference is added by registration.
 * Refresh only updates registered views; it does not make relocation safe while
 * native code holds borrowed pointers across guest calls. */
size_t QJS_SharedWrapperCount(void);
void QJS_SharedRefreshViews(QTSSharedStorage *storage);
/* Native-only group storage. Returned payload has prefixBytes zeroed bytes
 * immediately before it. The initial reference belongs to the caller. */
void *QTS_SharedAllocate(size_t payloadCapacity,size_t prefixBytes);
void QTS_SharedRetainBytes(void *payload);
void QTS_SharedReleaseBytes(void *payload);
#endif
