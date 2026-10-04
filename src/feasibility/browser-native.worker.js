// Architecture probe only. Not a security boundary or a published SDK backend.
import {newQuickJSWASMModuleFromVariant, newVariant} from 'quickjs-emscripten-core'
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync'
import {installNativeContext} from './native-context.js'

let engine
self.onmessage = async ({data}) => {
  try {
    const started = performance.now()
    let value, executionMs
    if (data.mode === 'quickjs') {
      if (data.optimized) {
        const base=new URL('/optimized/',location.href)
        const [core,loader,ffi]=await Promise.all(['core.mjs','engine.mjs','ffi.mjs'].map(file=>import(/* @vite-ignore */new URL(file,base).href)))
        const bytes=await(await fetch(new URL('engine.wasm',base))).arrayBuffer()
        engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>ffi.QuickJSAsyncFFI,importModuleLoader:async()=>()=>loader.default({wasmBinary:bytes})})
        engine.configureSharedStorage(16*1024*1024,false)
      } else {
        engine ??= await newQuickJSWASMModuleFromVariant(newVariant({
          ...RELEASE_SYNC,
          importModuleLoader: async () => (await import(/* @vite-ignore */ '/engine.mjs')).default,
        }, {wasmBinary: await (await fetch('/engine.wasm')).arrayBuffer()}))
      }
      const runtime = engine.newRuntime()
      runtime.setMemoryLimit(64 * 1024 * 1024)
      const deadline = Date.now() + 5000
      runtime.setInterruptHandler(() => Date.now() > deadline)
      const context = runtime.newContext()
      try {
        context.unwrapResult(context.evalCode(data.bootstrap)).dispose()
        const executionStart = performance.now()
        const handle = context.unwrapResult(context.evalCode(data.code))
        try {
          for (;;) {
            const state = context.getPromiseState(handle)
            if (state.type === 'fulfilled') {
              value = context.dump(state.value)
              if (state.value !== handle) state.value.dispose()
              break
            }
            if (state.type === 'rejected') {
              const error = context.dump(state.error); state.error.dispose()
              throw Error(JSON.stringify(error))
            }
            if (!runtime.hasPendingJob() || Date.now() > deadline) throw Error('Unsettled promise')
            context.unwrapResult(runtime.executePendingJobs(100))
          }
        } finally { handle.dispose() }
        executionMs = performance.now() - executionStart
      } finally { context.dispose(); runtime.dispose() }
    } else {
      // Each probe has its own worker, so these hooks cannot affect the host.
      installNativeContext({hostCallbacks:data.hostCallbacks === true})
      ;(0, eval)(data.bootstrap)
      const executionStart = performance.now()
      value = await (0, eval)(data.code)
      executionMs = performance.now() - executionStart
    }
    self.postMessage({ok:true, value, executionMs, elapsedMs:performance.now() - started})
  } catch (error) {
    self.postMessage({ok:false, error:String(error), stack:error?.stack})
  }
}
