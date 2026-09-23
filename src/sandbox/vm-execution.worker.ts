import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from 'quickjs-emscripten-core'
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync'
import wasmURL from '@jitl/quickjs-wasmfile-release-sync/wasm?url'
import alsBootstrap from './engine-als-bootstrap.js?raw'
import taskQueueBootstrap from './guest-task-queue.js?raw'

// Only the compiled guest bundle runs in QuickJS. No browser objects cross this boundary.
self.onmessage = async (event) => {
  if (event.data.type !== 'execute') return
  const { code, maxBytes, timeoutMs, env, argv } = event.data
  const engineALS = event.data.engine === 'quickjs-als'
  const variant = engineALS ? {
    ...RELEASE_SYNC,
    importModuleLoader: async () => {
      const url = new URL('/quickjs-als/engine.mjs', location.href).href
      return (await import(/* @vite-ignore */ url)).default
    },
  } : RELEASE_SYNC
  const engine = await newQuickJSWASMModuleFromVariant(
    newVariant(variant, {
      wasmLocation: new URL(engineALS ? '/quickjs-als/engine.wasm' : wasmURL, location.href).href,
    }),
  )
  const runtime = engine.newRuntime()
  runtime.setMemoryLimit(maxBytes)
  runtime.setMaxStackSize(256 * 1024)
  const deadline = performance.now() + timeoutMs
  runtime.setInterruptHandler(() => performance.now() > deadline)
  const context = runtime.newContext()
  context.unwrapResult(context.evalCode(taskQueueBootstrap)).dispose()
  const drainTicks=context.unwrapResult(context.evalCode("()=>globalThis[Symbol.for('web-container:task-queue')].drain()"))
  const pending = new Map<number, QuickJSDeferredPromise>()
  const timers = new Map<number, { timer: ReturnType<typeof setTimeout>; callback: QuickJSHandle }>()
  let nextId = 1
  let wake: (() => void) | undefined
  const ready:Array<()=>void>=[]
  const queue=(callback:()=>void)=>{ready.push(callback);wake?.()}
  const setFunction = (
    name: string,
    callback: Parameters<typeof context.newFunction>[1],
  ) => {
    const handle = context.newFunction(name, callback)
    context.setProp(context.global, name, handle)
    handle.dispose()
  }
  try {
    if (engineALS) context.unwrapResult(context.evalCode(alsBootstrap)).dispose()
    if (engineALS) {
      setFunction('__scheduleTimer', (callback, delay) => {
        if (timers.size >= 128) throw new Error('Too many pending timers')
        const id = nextId++
        const retained = callback.dup()
        const timer = setTimeout(() => {
          queue(()=>{
            if(!timers.has(id))return
            timers.delete(id)
            try{
              const result = context.callFunction(retained, context.undefined)
              context.unwrapResult(result).dispose()
            }finally{retained.dispose()}
          })
        }, Math.max(0, Math.min(context.getNumber(delay) || 0, 2147483647)))
        timers.set(id, { timer, callback: retained })
        return context.newNumber(id)
      })
      setFunction('__cancelTimer', id => {
        const key = context.getNumber(id)
        const entry = timers.get(key)
        if (entry) {
          clearTimeout(entry.timer)
          entry.callback.dispose()
          timers.delete(key)
        }
        return context.undefined
      })
    }
    setFunction('__fs', (method, args) => {
      if (pending.size >= 128)
        throw new Error('Too many pending filesystem calls')
      const id = nextId++
      const deferred = context.newPromise()
      pending.set(id, deferred)
      self.postMessage({
        type: 'fs',
        id,
        method: context.getString(method),
        args: context.getString(args),
      })
      return deferred.handle.dup()
    })
    setFunction('__print', (level, text) => {
      self.postMessage({
        type: 'output',
        level: context.getString(level),
        text: context.getString(text),
      })
      return context.undefined
    })
    self.onmessage = (event) => {
      if (event.data.type !== 'fs-result') return
      const data=event.data
      queue(()=>{
        const deferred = pending.get(data.id)
        if (!deferred) return
        pending.delete(data.id)
        const value = data.error ? context.newError(data.error) : context.newString(data.value)
        data.error ? deferred.reject(value) : deferred.resolve(value)
        value.dispose()
        deferred.dispose()
      })
    }
    context
      .unwrapResult(
        context.evalCode(`
      (() => {
        const rpc = __fs, print = __print;
        delete globalThis.__fs; delete globalThis.__print;
        const call = async (method, args) => JSON.parse(await rpc(method, JSON.stringify(args)));
        const fs = {
          readFile: async (path, options) => { const value = await call('readFile', [path, options]); return value?.bytes ? new Uint8Array(value.bytes) : value; },
          writeFile: (path, value, options) => {
            if (typeof value !== 'string' && !(value instanceof Uint8Array)) throw new TypeError('Expected string or Uint8Array');
            return call('writeFile', [path, typeof value === 'string' ? value : { bytes: Array.from(value) },options]);
          },
          readdir: (path, options) => call('readdir', [path, options]),
          stat: async path => { const value = await call('stat', [path]); return {...value, isFile: () => value.kind === 'file', isDirectory: () => value.kind === 'directory'}; },
        };
        for(const method of ['mkdir','rmdir','rm','unlink','rename','copyFile','truncate','chmod','access','realpath','symlink','readlink','lstat'])fs[method]=(...args)=>call(method,args);
        globalThis.__webContainerHost = { fs, env: ${JSON.stringify(env)}, argv: ${JSON.stringify(argv)} };
        if (globalThis.__engineAsyncLocalStorage) {
          globalThis.__webContainerHost.AsyncLocalStorage = globalThis.__engineAsyncLocalStorage;
          const ALS = globalThis.__engineAsyncLocalStorage, schedule = globalThis.__scheduleTimer, cancel = globalThis.__cancelTimer;
          globalThis.setTimeout = (callback, delay = 0, ...args) => {
            if (typeof callback !== 'function') throw new TypeError('Expected callback');
            return schedule(ALS.bind(() => globalThis[Symbol.for('web-container:task-queue')].task(callback,undefined,args)), Number(delay));
          };
          globalThis.clearTimeout = id => cancel(Number(id));
          delete globalThis.__scheduleTimer; delete globalThis.__cancelTimer;
          delete globalThis.__engineAsyncLocalStorage;
        }
        globalThis.console = Object.fromEntries(['log','info','warn','error','debug'].map(level => [level, (...args) => print(level, args.map(value => typeof value === 'string' ? value : value instanceof Error ? value.message : JSON.stringify(value)).join(' '))]));
        globalThis.queueMicrotask = callback => { Promise.resolve().then(callback); };
      })()
    `),
      )
      .dispose()
    const evaluation = context.evalCode(code, 'workspace.mjs', {
      type: 'module',
    })
    if (evaluation.error) {
      const error = context.dump(evaluation.error)
      evaluation.dispose()
      throw new Error(error?.message ?? JSON.stringify(error))
    }
    try {
      // Pump a bounded number of jobs, then yield to host RPC and cancellation.
      // A pending module with no runnable jobs waits for RPC, not a busy poll.
      for (;;) {
        if (performance.now() > deadline) throw new Error('Execution timed out')
        // Host yields do not end the current guest microtask checkpoint.
        // Admit one completion only after its predecessor's jobs and ticks.
        if(!runtime.hasPendingJob()){
          context.unwrapResult(context.callFunction(drainTicks,context.undefined)).dispose()
          if(!runtime.hasPendingJob())ready.shift()?.()
        }
        const jobs = runtime.executePendingJobs(100)
        if (jobs.error) {
          const error = context.dump(jobs.error)
          jobs.dispose()
          throw new Error(error?.message ?? JSON.stringify(error))
        }
        jobs.dispose()
        if(!runtime.hasPendingJob())context.unwrapResult(context.callFunction(drainTicks,context.undefined)).dispose()
        const state = context.getPromiseState(evaluation.value)
        if (state.type === 'fulfilled') {
          if (!state.notAPromise) state.value.dispose()
          if(!runtime.hasPendingJob())break
        }
        if (state.type === 'rejected') {
          const error = context.dump(state.error)
          state.error.dispose()
          throw new Error(error?.message ?? JSON.stringify(error))
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(
            () => {
              wake = undefined
              resolve()
            },
            runtime.hasPendingJob()||ready.length>0
              ? 0
              : Math.max(1, deadline - performance.now()),
          )
          wake = () => {
            clearTimeout(timer)
            wake = undefined
            resolve()
          }
        })
      }
    } finally {
      evaluation.dispose()
    }
    self.postMessage({
      type: 'done',
      wasmHeapBytes: engine.getWasmMemory().buffer.byteLength,
    })
  } catch (error) {
    self.postMessage({ type: 'error', error: String(error) })
  } finally {
    self.onmessage = null
    for (const entry of timers.values()) {
      clearTimeout(entry.timer)
      entry.callback.dispose()
    }
    for (const deferred of pending.values()) deferred.dispose()
    drainTicks.dispose()
    context.dispose()
    runtime.dispose()
  }
}
