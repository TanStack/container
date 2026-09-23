import type {WorkerKernel} from './kernel'
import {abortableWait} from './abortable-wait'
import {previewRequestTimeout} from './request-timeouts'

type Socket = Awaited<ReturnType<WorkerKernel['connect']>>
const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const encoder = new TextEncoder()

// One request per connection. No external network access or connection pooling.
export class WorkerHTTP {
  readonly requestTimeoutMs:number
  constructor(readonly kernel: Pick<WorkerKernel, 'connect'>, readonly port: number,options:{requestTimeoutMs?:number}={}) {
    this.requestTimeoutMs=previewRequestTimeout(options.requestTimeoutMs)
  }

  async fetch(request: Request): Promise<Response> {
    request.signal.throwIfAborted()
    const url = new URL(request.url)
    if (!token.test(request.method) || request.method === 'CONNECT')
      throw new Error('Unsupported HTTP method')
    const headers = new Headers(request.headers)
    // Strip connection-scoped fields before constructing our own framing.
    for (const name of (headers.get('connection') ?? '').split(','))
      if (name.trim()) headers.delete(name.trim())
    for (const name of ['connection','transfer-encoding','content-length','upgrade','expect','proxy-connection']) headers.delete(name)
    headers.set('host', url.host)
    headers.set('connection', 'close')
    headers.set('accept-encoding', 'identity')
    const chunks: Uint8Array[] = []
    let size = 0
    if (request.body) {
      const reader = request.body.getReader()
      try {
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          size += next.value.length
          if (size > 16 * 1024 * 1024) throw new Error('HTTP request body exceeds 16 MiB')
          chunks.push(next.value)
        }
      } catch (error) { await reader.cancel(error); throw error }
      finally { reader.releaseLock() }
      headers.set('content-length', String(size))
    } else {
      // Some browsers expose Body consumption methods without Request.body.
      // This native buffering cannot be interrupted or capped incrementally;
      // reject oversized results and cancellation before opening a socket.
      const body=await abortableWait(request.arrayBuffer(),request.signal)
      size=body.byteLength
      if(size>16*1024*1024)throw Error('HTTP request body exceeds 16 MiB')
      if(size){chunks.push(new Uint8Array(body));headers.set('content-length',String(size))}
    }
    const head = `${request.method} ${url.pathname}${url.search} HTTP/1.1\r\n${[...headers].map(([name,value])=>`${name}: ${value}\r\n`).join('')}\r\n`
    const bytes = encoder.encode(head)
    if (bytes.length > 16384) throw new Error('HTTP request headers exceed 16 KiB')
    request.signal.throwIfAborted()
    const socket = await this.kernel.connect(this.port)
    let closed = false
    const close = async () => {
      if (closed) return
      closed = true
      clearTimeout(timer)
      request.signal.removeEventListener('abort', abort)
      await socket.close()
    }
    let failure: unknown
    const abort = () => { failure = request.signal.reason; void close().catch(()=>{}) }
    const timer = setTimeout(() => { failure = new Error('HTTP response timed out'); void close().catch(()=>{}) }, this.requestTimeoutMs)
    request.signal.addEventListener('abort', abort, {once:true})
    if (request.signal.aborted) abort()
    try {
      await socket.write(bytes)
      for (const chunk of chunks)
        for (let offset=0;offset<chunk.length;offset+=65536) await socket.write(chunk.slice(offset,offset+65536))
      return await readHTTPResponse(socket, request.method, close, () => { if (failure) throw failure })
    } catch (error) { await close(); throw error }
  }
}

/** Parses the guest's untrusted wire bytes without buffering the response body. */
export async function readHTTPResponse(socket: Socket, method: string, close: () => Promise<void>, check = () => {}): Promise<Response> {
  let buffer = new Uint8Array(0), ended = false
  const more = async () => {
    check()
    const event = await socket.read()
    check()
    if (event?.type === 'error') throw new Error(`HTTP socket: ${event.code}`)
    if (!event || event.type === 'end' || event.type === 'close') { ended = true; return }
    if (event.type !== 'data') throw new Error('Unexpected HTTP socket event')
    const combined = new Uint8Array(buffer.length + event.bytes.length)
    combined.set(buffer); combined.set(event.bytes, buffer.length); buffer = combined
  }
  let headerBytes = 0
  const line = async (): Promise<string> => {
    for (;;) {
      let end = -1
      for (let i=0;i+1<buffer.length;i++) if (buffer[i]===13 && buffer[i+1]===10) { end=i;break }
      if (end >= 0) {
        headerBytes += end+2
        if (headerBytes > 16384) throw new Error('HTTP headers exceed 16 KiB')
        const text = Array.from(buffer.subarray(0,end), byte=>String.fromCharCode(byte)).join('')
        buffer = buffer.slice(end+2)
        return text
      }
      if (headerBytes + buffer.length > 16384) throw new Error('HTTP headers exceed 16 KiB')
      if (ended) throw new Error('Truncated HTTP line')
      await more()
    }
  }
  const fields = async () => {
    const headers = new Headers()
    for (;;) {
      const text = await line()
      if (!text) return headers
      const colon = text.indexOf(':')
      if (colon < 1 || !token.test(text.slice(0,colon))) throw new Error('Invalid HTTP header')
      const value = text.slice(colon+1).trim()
      if (/[^\t\x20-\x7e\x80-\xff]/.test(value)) throw new Error('Invalid HTTP header value')
      headers.append(text.slice(0,colon), value)
    }
  }
  let status = 0, headers: Headers
  do {
    const match = /^HTTP\/1\.[01] ([0-9]{3})(?: [\x20-\x7e\x80-\xff]*)?$/.exec(await line())
    if (!match) throw new Error('Invalid HTTP status')
    status = Number(match[1]); headers = await fields()
    if (status === 101) throw new Error('HTTP upgrade requires a WebSocket transport')
  } while (status >= 100 && status < 200)
  if (status < 200 || status > 599) throw new Error('Invalid HTTP status')
  const transfer = headers.get('transfer-encoding')
  const length = headers.get('content-length')
  if (transfer && (transfer.toLowerCase() !== 'chunked' || length !== null)) throw new Error('Ambiguous HTTP framing')
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) throw new Error('Invalid HTTP content length')
  for (const name of (headers.get('connection') ?? '').split(',')) if (name.trim()) headers.delete(name.trim())
  for (const name of ['connection','transfer-encoding','keep-alive','proxy-connection']) headers.delete(name)
  if (method === 'HEAD' || [204,205,304].includes(status)) {
    await close()
    return new Response(null,{status,headers})
  }
  let remaining = length === null ? Infinity : Number(length), chunkLeft = 0, chunkCRLF = false, received = 0
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        check()
        if (transfer) {
          if (chunkCRLF) { headerBytes=0; if (await line() !== '') throw new Error('Invalid HTTP chunk terminator'); chunkCRLF=false }
          if (!chunkLeft) {
            headerBytes=0
            const text = await line()
            if (!/^[0-9a-fA-F]+(?:;[\x20-\x7e]*)?$/.test(text)) throw new Error('Invalid HTTP chunk size')
            chunkLeft = parseInt(text.split(';')[0],16)
            if (!Number.isSafeInteger(chunkLeft)) throw new Error('Invalid HTTP chunk size')
            if (!chunkLeft) { await fields(); await close(); controller.close(); return }
          }
        } else if (!remaining) { await close(); controller.close(); return }
        while (!buffer.length && !ended) await more()
        if (!buffer.length) {
          if (transfer || remaining !== Infinity) throw new Error('Truncated HTTP body')
          await close(); controller.close(); return
        }
        const count = Math.min(buffer.length,transfer ? chunkLeft : remaining)
        received += count
        if (received > 16*1024*1024) throw new Error('HTTP response exceeds 16 MiB')
        const bytes = buffer.slice(0,count); buffer=buffer.slice(count)
        if (transfer) { chunkLeft-=count; chunkCRLF=chunkLeft===0 } else remaining-=count
        controller.enqueue(bytes)
      } catch (error) { await close(); controller.error(error) }
    },
    cancel: close,
  }, {highWaterMark:0})
  return new Response(stream,{status,headers})
}
