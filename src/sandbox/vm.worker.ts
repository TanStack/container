import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
} from 'quickjs-emscripten-core'
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync'
import wasmURL from '@jitl/quickjs-wasmfile-release-sync/wasm?url'

self.onmessage = async (event) => {
  const started = performance.now()
  try {
    const engine = await newQuickJSWASMModuleFromVariant(
      newVariant(RELEASE_SYNC, {
        wasmLocation: new URL(wasmURL, location.href).href,
      }),
    )
    const bootMs = performance.now() - started
    const runtime = engine.newRuntime()
    runtime.setMemoryLimit(event.data.maxBytes)
    runtime.setMaxStackSize(256 * 1024)
    const deadline = performance.now() + event.data.timeoutMs
    runtime.setInterruptHandler(() => performance.now() > deadline)
    const context = runtime.newContext()
    const evaluationStart = performance.now()
    try {
      const result = context.evalCode(event.data.code, 'guest.js')
      try {
        const value = context.dump(result.error ?? result.value)
        self.postMessage({
          ok: !result.error,
          value,
          bootMs,
          executionMs: performance.now() - evaluationStart,
          wasmHeapBytes: engine.getWasmMemory().buffer.byteLength,
        })
      } finally {
        result.dispose()
      }
    } finally {
      context.dispose()
      runtime.dispose()
    }
  } catch (error) {
    self.postMessage({
      ok: false,
      value: { message: String(error) },
      bootMs: performance.now() - started,
      executionMs: 0,
    })
  }
}
