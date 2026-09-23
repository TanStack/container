#ifndef QWASM_FIBER_STATE_H
#define QWASM_FIBER_STATE_H

#include "quickjs.h"

struct CallFrame;
struct Retired;

/* Borrowed execution roots, not independently owned values. The suspended
 * fiber keeps its native stack, runtime, contexts and call owners alive.
 * Class IDs and native object ownership remain engine-wide, not fiber state. */
typedef struct QWasmFiberState {
  JSRuntime *allocator_runtime;
  JSContext *active_context;
  unsigned interrupt_ticks;
  int interrupted;
  JSValue bridge_helper;
  struct CallFrame *active_call;
  struct Retired **retired_roots;
} QWasmFiberState;

/* Save before leaving a fiber, restore the scheduler state, then restore the
 * fiber state before resuming it. These operations allocate no guest values. */
void QWasmFiberSave(QWasmFiberState *state);
void QWasmFiberRestore(const QWasmFiberState *state);
/* Fairness must not suspend a native WASM operation or its imported JS calls. */
int QWasmFiberCanYield(void);

#endif
