export class AsyncLocalStorage<T = unknown> {
  #store: T | undefined

  disable() { this.#store = undefined }
  enterWith(store: T) { this.#store = store }
  getStore() { return this.#store }
  run<R>(store: T, callback: (...args: never[]) => R, ...args: never[]): R {
    const previous = this.#store
    this.#store = store
    try {
      return callback(...args)
    } finally {
      this.#store = previous
    }
  }
}

export default { AsyncLocalStorage }
