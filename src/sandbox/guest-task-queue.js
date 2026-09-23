// Guest-owned Node task checkpoints. Promise jobs remain owned by QuickJS.
(() => {
  const key = Symbol.for('web-container:task-queue')
  if (globalThis[key]) return
  let queue = [], cursor = 0, draining = false, depth = 0
  const drain = () => {
    if (draining || depth) return 0
    draining = true
    let count = 0
    try {
      while (cursor < queue.length) {
        const entry = queue[cursor]
        queue[cursor++] = undefined
        entry.callback(...entry.args)
        count++
      }
      return count
    } finally {
      queue = queue.slice(cursor)
      cursor = 0
      draining = false
    }
  }
  const nextTick = (callback, ...args) => {
    if (typeof callback !== 'function')
      throw Object.assign(new TypeError('Expected a callback'), { code: 'ERR_INVALID_ARG_TYPE' })
    const ALS = globalThis.__webContainerHost?.AsyncLocalStorage ?? globalThis.__engineAsyncLocalStorage
    queue.push({ callback: ALS ? ALS.bind(callback) : callback, args })
  }
  const task = (callback, receiver, args = []) => {
    depth++
    let completed = false
    try { const result = Reflect.apply(callback, receiver, args); completed = true; return result }
    finally { depth--; if (!depth && completed) drain() }
  }
  Object.defineProperty(globalThis, key, { value: { mode: 'node-checkpoints', nextTick, drain, task, get pending() { return queue.length - cursor } } })
})()
