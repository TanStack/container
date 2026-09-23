// Trusted protocol test adapter. Never expose these raw pointers to guest code.
export async function createPeer(factory, wasmBinary, server, maximum = 4 * 1024 * 1024) {
  const m = await factory({ wasmBinary })
  const check = value => {
    if (value < 0) throw new Error(`nghttp2: ${value}`)
    return value
  }
  check(m._h2_init(Number(server), maximum))
  const scratch = m._h2_allocate(65536)
  if (!scratch) { m._h2_close(); throw new Error('Scratch allocation failed') }
  let closed = false
  const temporary = (values, action) => {
    const pointers = []
    try {
      for (const value of values) {
        const bytes = typeof value === 'string' ? new TextEncoder().encode(value + '\0') : value
        const pointer = m._h2_allocate(bytes.length)
        if (!pointer) throw new Error('Argument allocation failed')
        pointers.push(pointer)
        m.HEAPU8.set(bytes, pointer)
      }
      return check(action(...pointers))
    } finally { for (const pointer of pointers) m._h2_free(pointer) }
  }
  return {
    request(body, path = '/') {
      return temporary(['POST', path, 'localhost', body], (method, url, host, data) => m._h2_request(method, url, host, data, body.length))
    },
    response(stream, body) {
      return temporary(['200', body], (status, data) => m._h2_response(stream, status, data, body.length))
    },
    requestStart(path = '/') {
      return temporary(['POST', path, 'localhost'], (method, url, host) => m._h2_request_start(method, url, host))
    },
    responseStart(stream) { return temporary(['200'], status => m._h2_response_start(stream, status)) },
    write(stream, body, end = false) {
      return temporary([body], data => m._h2_write(stream, data, body.length, Number(end)))
    },
    queued(stream) { return check(m._h2_queued(stream)) },
    consume(stream, length) { return check(m._h2_consume(stream, length)) },
    reset(stream, code = 8) { return check(m._h2_reset(stream, code)) },
    feed(bytes) {
      if (bytes.length > 65536) throw new Error('Input chunk exceeds adapter limit')
      m.HEAPU8.set(bytes, scratch)
      const consumed = check(m._h2_feed(scratch, bytes.length))
      if (consumed !== bytes.length) throw new Error(`Partial input: ${consumed}/${bytes.length}`)
    },
    send(size = 65536) {
      const length = check(m._h2_send(scratch, size))
      return m.HEAPU8.slice(scratch, scratch + length)
    },
    events() {
      const events = []
      while (m._h2_event_type()) {
        const pointer = m._h2_event_data(), length = m._h2_event_length()
        events.push({ type: m._h2_event_type(), stream: m._h2_event_stream(), flags: m._h2_event_flags(), bytes: m.HEAPU8.slice(pointer, pointer + length) })
        m._h2_pop()
      }
      return events
    },
    peak() { return m._h2_peak() },
    close() {
      if (closed) return 0
      closed = true
      m._h2_free(scratch)
      const remaining = m._h2_close()
      if (remaining !== 0) throw new Error(`Leaked ${remaining} bytes`)
      return remaining
    },
  }
}
