// Runs only inside the opaque-origin frame's worker. The host owns the files.
// Native browser jobs cannot expose Node's separate nextTick checkpoint.
Object.defineProperty(globalThis,Symbol.for('web-container:task-queue'),{value:{
  mode:'approximate-microtask',
  nextTick(callback,...args){if(typeof callback!=='function')throw new TypeError('Expected callback');queueMicrotask(()=>callback(...args))},
  task:(callback,receiver,args=[])=>Reflect.apply(callback,receiver,args),
}})
let channel
let nextId = 1
const pending = new Map()
const send = (message) => channel.postMessage(message)
const rpc = (method, args) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    send({ type: 'fs', id, method, args })
  })
const print = (level, args) => {
  const text = args
    .map((value) => {
      try {
        return typeof value === 'string'
          ? value
          : value instanceof Error
            ? value.message
            : JSON.stringify(value)
      } catch {
        return String(value)
      }
    })
    .join(' ')
  send({ type: 'output', level, text })
}
let handler
let queue = Promise.resolve()
self.onmessage = (event) => {
  if (channel) return
  channel = event.ports[0]
  channel.onmessage = async (event) => {
    const message = event.data
    if (message.type === 'fs-result') {
      const call = pending.get(message.id)
      if (!call) return
      pending.delete(message.id)
      message.error
        ? call.reject(new Error(message.error))
        : call.resolve(message.value)
      return
    }
    if (message.type === 'load') {
      try {
        const fs = {
          readFile: (path, options) => rpc('readFile', [path, options]),
          writeFile: (path, contents, options) =>
            rpc('writeFile', [
              path,
              typeof contents === 'string'
                ? new TextEncoder().encode(contents)
                : contents,
              options,
            ]),
          readdir: (path, options) => rpc('readdir', [path, options]),
          stat: async (path) => {
            const value = await rpc('stat', [path])
            return {
              ...value,
              isFile: () => value.kind === 'file',
              isDirectory: () => value.kind === 'directory',
            }
          },
        }
        for(const method of ['mkdir','rmdir','rm','unlink','rename','copyFile','truncate','chmod','access','realpath','symlink','readlink','lstat'])fs[method]=(...args)=>rpc(method,args)
        globalThis.__webContainerHost = {
          fs,
          env: message.env,
          argv: message.argv,
        }
        for (const level of ['log', 'info', 'warn', 'error', 'debug'])
          console[level] = (...args) => print(level, args)
        const url = URL.createObjectURL(
          new Blob([message.code], { type: 'text/javascript' }),
        )
        try {
          const module = await import(url)
          handler =
            typeof module.default === 'function'
              ? module.default
              : module.default?.fetch?.bind(module.default)
          send({ type: 'loaded', hasHandler: !!handler })
        } finally {
          URL.revokeObjectURL(url)
        }
      } catch (error) {
        send({
          type: 'error',
          error: String(error) + '\n' + (error?.stack ?? ''),
        })
      }
    }
    if (message.type === 'request') {
      // The existing ALS shim does not support overlapping request contexts.
      queue = queue.then(async () => {
        try {
          if (!handler)
            throw new Error('Module does not export a fetch handler')
          const request = new IncomingRequest(message.url, {
            method: message.method,
            headers: message.headers,
            body: message.body,
          })
          const response = await handler(request)
          if (!(response instanceof Response))
            throw new Error('Handler must return a Response')
          const body = new Uint8Array(await response.arrayBuffer())
          send({
            type: 'response',
            id: message.id,
            status: response.status,
            headers: [...response.headers],
            body,
          })
        } catch (error) {
          send({ type: 'response', id: message.id, error: String(error) })
        }
      })
    }
  }
  channel.start()
  send({ type: 'ready' })
}
