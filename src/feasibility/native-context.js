// Experimental browser-native context adapter. Not installed in the SDK.
// Promise reaction hooks cannot observe intrinsic native await continuations.
export function installNativeContext({hostCallbacks = false} = {}) {
  let frame
  globalThis.__qjsGetAsyncContext = () => frame
  globalThis.__qjsSetAsyncContext = value => { frame = value }
  const bind = callback => {
    if (typeof callback !== 'function') return callback
    const captured = frame
    return function (...args) {
      const previous = frame; frame = captured
      try { return Reflect.apply(callback, this, args) } finally { frame = previous }
    }
  }
  const originalThen = Promise.prototype.then
  Promise.prototype.then = function (fulfilled, rejected) {
    return originalThen.call(this, bind(fulfilled), bind(rejected))
  }
  if (hostCallbacks) {
    for (const name of ['setTimeout', 'setInterval', 'queueMicrotask']) {
      const original = globalThis[name]
      globalThis[name] = (callback, ...args) => original(bind(callback), ...args)
    }
  }
}
