// Evaluated inside QuickJS, never in the browser's realm. No async transform.
(() => {
  const get = globalThis.__qjsGetAsyncContext
  const set = globalThis.__qjsSetAsyncContext
  if (typeof get !== 'function' || typeof set !== 'function')
    throw new Error('QuickJS async-context engine patch is missing')
  delete globalThis.__qjsGetAsyncContext
  delete globalThis.__qjsSetAsyncContext
  delete globalThis.__qjsDisableStringCodeGeneration
  delete globalThis.__qjsContextifyGlobal
  delete globalThis.__qjsCreateContext
  delete globalThis.__qjsExecutePendingJobs
  const states = new WeakMap()
  function invoke(frame, callback, receiver, args) {
    if (typeof callback !== 'function') throw new TypeError('Expected callback')
    const previous = get()
    set(frame)
    try { return Reflect.apply(callback, receiver, args) }
    finally { set(previous) }
  }
  class AsyncLocalStorage {
    constructor(options = {}) {
      states.set(this, { defaultValue: options.defaultValue })
      Object.defineProperty(this, 'name', { value: options.name === undefined ? '' : String(options.name), configurable: true })
    }
    getStore() {
      const state = states.get(this)
      const frame = get()
      return frame?.has(this) ? frame.get(this) : state.defaultValue
    }
    run(value, callback, ...args) {
      if (typeof callback !== 'function') throw new TypeError('Expected callback')
      const previous = this.getStore()
      if (Object.is(previous, value)) return Reflect.apply(callback, null, args)
      this.enterWith(value)
      try { return Reflect.apply(callback, null, args) }
      finally { this.enterWith(previous) }
    }
    enterWith(value) {
      const frame = new Map(get())
      frame.set(this, value)
      set(frame)
    }
    exit(callback, ...args) {
      return this.run(undefined, callback, ...args)
    }
    disable() {
      // Match Node 24's AsyncContextFrame implementation: this frame only.
      get()?.delete(this)
    }
    static bind(callback) {
      const frame = get()
      return function (...args) { return invoke(frame, callback, this, args) }
    }
    static snapshot() {
      const frame = get()
      return (callback, ...args) => invoke(frame, callback, undefined, args)
    }
  }
  Object.defineProperty(globalThis, '__engineAsyncLocalStorage', { value: AsyncLocalStorage, configurable: true })
})()
