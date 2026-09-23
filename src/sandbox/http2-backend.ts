import {runtimeAssetURL} from './runtime-assets'
export type HTTP2Module = { HEAPU8: Uint8Array; [name: `_h2_${string}`]: (...args: number[]) => number }
type Owner = { closed: boolean; ready: Promise<void>; module?: HTTP2Module; scratch: number; maxBytes: number }
type Handle = { owner: number; record: Owner; local: number; failed: boolean }
const failure = (code: string, message: string) => Object.assign(new Error(message), { code })
const encoder = new TextEncoder(), decoder = new TextDecoder()
let loader: Promise<() => HTTP2Module> | undefined
const defaultFactory = async () => { loader ??= loadHTTP2Factory(); return (await loader)() }

export async function loadHTTP2Factory(assetBaseURL?:string): Promise<() => HTTP2Module> {
  const base = runtimeAssetURL('http2-runtime/',assetBaseURL)
  const path = new URL('http2.mjs', base).href
  const [{ default: create }, response] = await Promise.all([import(/* @vite-ignore */ path), fetch(new URL('http2.wasm', base))])
  if (!response.ok) throw new Error(`HTTP/2 runtime download failed: ${response.status}`)
  const wasmBinary = new Uint8Array(await response.arrayBuffer())
  return () => {
    let initialized = false
    const options = { wasmBinary, onRuntimeInitialized() { initialized = true } }
    const completion = create(options)
    if (!initialized) {
      void Promise.resolve(completion).catch(() => {})
      throw new Error('HTTP/2 runtime did not initialize synchronously')
    }
    return options as unknown as HTTP2Module
  }
}

/** Owner IDs come from the process manager, never from guest arguments. */
export class HTTP2Backend {
  #owners = new Map<number, Owner>()
  #retiring = new Set<Owner>()
  #handles = new Map<number, Handle>()
  #next = 1
  constructor(private factory: () => Promise<HTTP2Module> | HTTP2Module = defaultFactory, private maxOwners = 4, private syncFactory?: () => HTTP2Module) {
    if (!Number.isInteger(maxOwners) || maxOwners < 1 || maxOwners > 32) throw failure('EINVAL', 'Invalid HTTP/2 owner limit')
  }
  #reserve(owner: number, maxBytes: number, maxSessions: number) {
    if (!Number.isSafeInteger(owner) || owner < 1 || !Number.isInteger(maxBytes) || maxBytes < 65536 || maxBytes > 32 * 1024 * 1024 || !Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 32) throw failure('EINVAL', 'Invalid HTTP/2 owner limits')
    if (this.#owners.has(owner)) throw failure('EBUSY', 'HTTP/2 owner already exists')
    if (this.#owners.size + this.#retiring.size >= this.maxOwners) throw failure('EMFILE', 'HTTP/2 owner limit exceeded')
    const record: Owner = { closed: false, ready: Promise.resolve(), scratch: 0, maxBytes }
    this.#owners.set(owner, record)
    return record
  }
  #initialize(record: Owner, module: HTTP2Module, maxSessions: number) {
    record.module = module
    this.#check(module._h2_initialize(record.maxBytes, maxSessions))
    record.scratch = module._h2_allocate(65536)
    if (!record.scratch) throw failure('ERR_RESOURCE_LIMIT', 'HTTP/2 scratch allocation exceeded the owner budget')
  }
  createOwnerSync(owner: number, { maxBytes = 4 * 1024 * 1024, maxSessions = 32 } = {}) {
    if (!this.syncFactory) throw failure('ERR_UNSUPPORTED_OPERATION', 'Synchronous HTTP/2 factory is unavailable')
    const record = this.#reserve(owner, maxBytes, maxSessions)
    try { this.#initialize(record, this.syncFactory(), maxSessions) }
    catch (error) { this.#dispose(record); this.#owners.delete(owner); throw error }
  }
  async createOwner(owner: number, { maxBytes = 4 * 1024 * 1024, maxSessions = 32 } = {}) {
    const record = this.#reserve(owner, maxBytes, maxSessions)
    record.ready = (async () => {
      const module = record.module = await this.factory()
      if (!record.closed) this.#initialize(record, module, maxSessions)
    })().catch(error => {
      this.#dispose(record)
      if (this.#owners.get(owner) === record) this.#owners.delete(owner)
      throw error
    })
    await record.ready
    if (record.closed) throw failure('ECANCELED', 'HTTP/2 owner closed during initialization')
  }
  #dispose(record: Owner) {
    if (!record.module) return
    if (record.scratch) record.module._h2_free(record.scratch)
    record.scratch = 0
    const remaining = record.module._h2_shutdown()
    record.module = undefined
    if (remaining) throw failure('ERR_HTTP2_CLEANUP', `HTTP/2 owner retained ${remaining} tracked bytes`)
  }
  async closeOwner(owner: number) {
    const record = this.#owners.get(owner)
    if (!record) return
    record.closed = true; this.#owners.delete(owner); this.#retiring.add(record)
    for (const [id, handle] of this.#handles) if (handle.record === record) this.#handles.delete(id)
    await record.ready.catch(() => {})
    this.#dispose(record); this.#retiring.delete(record)
  }
  #owner(owner: number) {
    const record = this.#owners.get(owner)
    if (!record || record.closed || !record.module || !record.scratch) throw failure('EBADF', 'HTTP/2 owner is unavailable')
    return record
  }
  #handle(owner: number, id: number, allowFailed = false) {
    const handle = this.#handles.get(id)
    if (!handle || handle.owner !== owner || handle.record !== this.#owners.get(owner) || handle.record.closed) throw failure('EBADF', 'HTTP/2 session is unavailable to this owner')
    if (handle.failed && !allowFailed) throw failure('ERR_HTTP2_SESSION_ERROR', 'HTTP/2 session failed')
    return { handle, module: handle.record.module!, local: handle.local, scratch: handle.record.scratch }
  }
  #check(code: number) {
    if (code < 0) throw Object.assign(failure(code === -901 ? 'ERR_RESOURCE_LIMIT' : 'ERR_HTTP2_BACKEND', `nghttp2: ${code}`), { http2Code: code })
    return code
  }
  #bytes(bytes: Uint8Array) {
    if (!(bytes instanceof Uint8Array) || bytes.length > 65536) throw failure('EINVAL', 'Expected at most 64 KiB of HTTP/2 bytes')
  }
  #stream(stream: number) { if (!Number.isInteger(stream) || stream < 1 || stream > 2147483647) throw failure('EINVAL', 'Invalid HTTP/2 stream') }
  #text(value: string, maximum: number) {
    if (typeof value !== 'string' || !value.length || value.includes('\0') || value.length > maximum) throw failure('EINVAL', 'Invalid HTTP/2 header')
    const bytes = encoder.encode(value + '\0')
    if (bytes.length > maximum + 1) throw failure('EINVAL', 'HTTP/2 header exceeds its byte limit')
    return bytes
  }
  #strings(module: HTTP2Module, values: Uint8Array[], action: (...pointers: number[]) => number) {
    const pointers: number[] = []
    try {
      for (const bytes of values) {
        const pointer = module._h2_allocate(bytes.length)
        if (!pointer) throw failure('ERR_RESOURCE_LIMIT', 'HTTP/2 argument allocation exceeded the owner budget')
        pointers.push(pointer); module.HEAPU8.set(bytes, pointer)
      }
      return this.#check(action(...pointers))
    } finally { for (const pointer of pointers) module._h2_free(pointer) }
  }
  open(owner: number, server = false) {
    if (typeof server !== 'boolean') throw failure('EINVAL', 'Invalid HTTP/2 role')
    const record = this.#owner(owner)
    if (this.#next >= Number.MAX_SAFE_INTEGER) throw failure('EMFILE', 'HTTP/2 handle space exhausted')
    const local = this.#check(record.module!._h2_open(Number(server)))
    const id = this.#next++; this.#handles.set(id, { owner, record, local, failed: false }); return id
  }
  request(owner: number, id: number, method = 'POST', path = '/', authority = 'localhost') {
    const h = this.#handle(owner, id)
    return this.#strings(h.module, [this.#text(method, 32), this.#text(path, 8192), this.#text(authority, 255)], (method, path, authority) => h.module._h2_request_start(h.local, method, path, authority))
  }
  respond(owner: number, id: number, stream: number, status = 200) {
    const h = this.#handle(owner, id); this.#stream(stream)
    if (!Number.isInteger(status) || status < 200 || status > 599) throw failure('EINVAL', 'Invalid HTTP/2 final status')
    return this.#strings(h.module, [this.#text(String(status), 3)], status => h.module._h2_response_start(h.local, stream, status))
  }
  headers(owner: number, id: number, stream: number, headers: [string, string][], end = false, waitForTrailers = false) {
    return this.#headerBlock(owner,id,stream,headers,end,waitForTrailers,false)
  }
  trailers(owner:number,id:number,stream:number,headers:[string,string][]) {
    this.#stream(stream)
    return this.#headerBlock(owner,id,stream,headers,false,false,true)
  }
  #headerBlock(owner:number,id:number,stream:number,headers:[string,string][],end:boolean,waitForTrailers:boolean,trailers:boolean) {
    const h = this.#handle(owner, id)
    if (stream !== 0) this.#stream(stream)
    if (typeof end !== 'boolean' || typeof waitForTrailers !== 'boolean' || !Array.isArray(headers) || headers.length < (trailers?0:1) || headers.length > 128) throw failure('EINVAL', 'Invalid HTTP/2 headers')
    const values: string[] = []
    let size = 0
    for (const entry of headers) {
      if (!Array.isArray(entry) || entry.length !== 2) throw failure('EINVAL', 'Invalid HTTP/2 header pair')
      const [name, value] = entry
      if (typeof name !== 'string' || !/^:?[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || typeof value !== 'string' || /[\0\r\n]/.test(value)) throw failure('EINVAL', 'Invalid HTTP/2 header name or value')
      if(trailers&&name.startsWith(':'))throw failure('EINVAL','Invalid HTTP/2 trailer name')
      size += name.length + value.length + 2
      if (size > 65536) throw failure('EINVAL', 'HTTP/2 headers exceed transport limit')
      values.push(name, value)
    }
    const bytes = encoder.encode(values.length?values.join('\0') + '\0':'')
    this.#bytes(bytes); h.module.HEAPU8.set(bytes, h.scratch)
    return this.#check(trailers?h.module._h2_trailers(h.local,stream,h.scratch,bytes.length):h.module._h2_headers(h.local, stream, h.scratch, bytes.length, Number(end),Number(waitForTrailers)))
  }
  write(owner: number, id: number, stream: number, bytes: Uint8Array, end = false) {
    const h = this.#handle(owner, id); this.#stream(stream); this.#bytes(bytes)
    if (typeof end !== 'boolean') throw failure('EINVAL', 'Invalid HTTP/2 end flag')
    h.module.HEAPU8.set(bytes, h.scratch)
    return this.#check(h.module._h2_write(h.local, stream, h.scratch, bytes.length, Number(end)))
  }
  queued(owner: number, id: number, stream: number) {
    const h = this.#handle(owner, id); this.#stream(stream)
    return this.#check(h.module._h2_queued(h.local, stream))
  }
  consume(owner: number, id: number, stream: number, length: number) {
    const h = this.#handle(owner, id); this.#stream(stream)
    if (!Number.isInteger(length) || length < 0 || length > 2147483647) throw failure('EINVAL', 'Invalid HTTP/2 consumed length')
    return this.#check(h.module._h2_consume(h.local, stream, length))
  }
  reset(owner: number, id: number, stream: number, code = 8) {
    const h = this.#handle(owner, id); this.#stream(stream)
    if (!Number.isInteger(code) || code < 0 || code > 0xffffffff) throw failure('EINVAL', 'Invalid HTTP/2 reset code')
    return this.#check(h.module._h2_reset(h.local, stream, code))
  }
  goaway(owner: number, id: number, code = 0) {
    const h = this.#handle(owner, id)
    if (!Number.isInteger(code) || code < 0 || code > 0xffffffff) throw failure('EINVAL', 'Invalid HTTP/2 GOAWAY code')
    return this.#check(h.module._h2_goaway(h.local, code))
  }
  feed(owner: number, id: number, bytes: Uint8Array) {
    const h = this.#handle(owner, id); this.#bytes(bytes); h.module.HEAPU8.set(bytes, h.scratch)
    try { return this.#check(h.module._h2_feed(h.local, h.scratch, bytes.length)) }
    catch (error) { h.handle.failed = true; throw error }
  }
  send(owner: number, id: number, maximum = 65536) {
    const h = this.#handle(owner, id)
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 65536) throw failure('EINVAL', 'Invalid HTTP/2 output size')
    try {
      const length = this.#check(h.module._h2_send(h.local, h.scratch, maximum))
      return h.module.HEAPU8.slice(h.scratch, h.scratch + length)
    } catch (error) { h.handle.failed = true; throw error }
  }
  events(owner: number, id: number) {
    const h = this.#handle(owner, id), result = []
    for (;;) {
      const type = this.#check(h.module._h2_event_type(h.local))
      if (!type) return result
      const stream = h.module._h2_event_stream(h.local), flags = h.module._h2_event_flags(h.local)
      const length = this.#check(h.module._h2_event_length(h.local)), pointer = h.module._h2_event_data(h.local)
      const bytes = h.module.HEAPU8.slice(pointer, pointer + length)
      result.push({ type, stream, flags, bytes })
      this.#check(h.module._h2_pop(h.local))
    }
  }
  destroy(owner: number, id: number) {
    const h = this.#handle(owner, id, true)
    this.#check(h.module._h2_destroy(h.local)); this.#handles.delete(id)
  }
  stats(owner: number) {
    const record = this.#owner(owner), module = record.module!
    return { sessions: module._h2_count(), allocated: module._h2_allocated(), peak: module._h2_peak(), maxBytes: record.maxBytes, linearMemoryBytes: module.HEAPU8.length }
  }
}
