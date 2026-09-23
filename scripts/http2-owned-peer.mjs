// Reuse the protocol regression harness against one session of an owned module.
// Production callers use HTTP2Backend, not this test-only adapter.
export function singlePeerFactory(factory) {
  return async options => {
    const module = await factory(options)
    let id = 0
    const facade = {
      get HEAPU8() { return module.HEAPU8 },
      _h2_init(server, maximum) {
        const result = module._h2_initialize(maximum, 32)
        if (result < 0) return result
        id = module._h2_open(server)
        if (id < 0) { module._h2_shutdown(); return id }
        return 0
      },
      _h2_close() { return module._h2_shutdown() },
    }
    for (const name of ['allocate', 'free', 'allocated', 'peak', 'error']) facade['_h2_' + name] = (...args) => module['_h2_' + name](...args)
    for (const name of ['request', 'response', 'request_start', 'response_start', 'write', 'queued', 'consume', 'feed', 'send', 'reset', 'pop', 'event_type', 'event_stream', 'event_flags', 'event_length', 'event_data']) facade['_h2_' + name] = (...args) => module['_h2_' + name](id, ...args)
    const text = pointer => new TextDecoder().decode(module.HEAPU8.subarray(pointer, module.HEAPU8.indexOf(0, pointer)))
    const headers = (stream, values) => {
      const bytes = new TextEncoder().encode(values.flat().join('\0') + '\0')
      const pointer = module._h2_allocate(bytes.length)
      if (!pointer) return -901
      try { module.HEAPU8.set(bytes, pointer); return module._h2_headers(id, stream, pointer, bytes.length, 0, 0) }
      finally { module._h2_free(pointer) }
    }
    facade._h2_request_start = (method, path, authority) => headers(0, [[':method', text(method)], [':scheme', 'http'], [':authority', text(authority)], [':path', text(path)], ['x-owned', '42']])
    facade._h2_response_start = (stream, status) => headers(stream, [[':status', text(status)], ['x-owned', '42']])
    return facade
  }
}
