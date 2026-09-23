import RuntimeWorker from './runtime.worker?worker'
import type { FileSnapshot } from '../fs/types'
import type { HostToRuntimeMessage, RuntimeToHostMessage } from './protocol'

interface PendingLoad {
  reject(error: Error): void
  resolve(): void
  type: 'load'
}

interface PendingRequest {
  controller: ReadableStreamDefaultController<Uint8Array>
  reject(error: Error): void
  resolve(response: Response): void
  type: 'request'
}

export class BrowserRuntime {
  readonly #worker = new RuntimeWorker()
  readonly #pending = new Map<number, PendingLoad | PendingRequest>()
  #nextId = 1

  constructor() {
    this.#worker.onmessage = (event: MessageEvent<RuntimeToHostMessage>) => {
      this.#onMessage(event.data)
    }
    this.#worker.onerror = (event) => {
      const error = new Error(event.message || 'Runtime worker crashed')
      for (const pending of this.#pending.values()) pending.reject(error)
      this.#pending.clear()
    }
  }

  load(code: string, files: FileSnapshot, env: Record<string, string> = {}): Promise<void> {
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { type: 'load', resolve, reject })
      this.#post({ type: 'load', id, code, files, env })
    })
  }

  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init)
    const body = request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : await request.arrayBuffer()
    const id = this.#nextId++

    return new Promise<Response>((resolve, reject) => {
      let controller!: ReadableStreamDefaultController<Uint8Array>
      new ReadableStream<Uint8Array>({
        start(value) {
          controller = value
        },
      })
      this.#pending.set(id, { type: 'request', controller, resolve, reject })
      this.#post(
        {
          type: 'request',
          id,
          request: {
            body,
            headers: [...request.headers.entries()],
            method: request.method,
            url: request.url,
          },
        },
        body ? [body] : [],
      )
    })
  }

  close(): void {
    this.#worker.terminate()
  }

  #onMessage(message: RuntimeToHostMessage): void {
    const pending = this.#pending.get(message.id)
    if (!pending) return

    if (message.type === 'error') {
      const error = new Error(message.message)
      error.stack = message.stack
      pending.reject(error)
      if (pending.type === 'request') pending.controller.error(error)
      this.#pending.delete(message.id)
      return
    }

    if (message.type === 'loaded' && pending.type === 'load') {
      pending.resolve()
      this.#pending.delete(message.id)
      return
    }

    if (pending.type !== 'request') return
    if (message.type === 'response-start') {
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          pending.controller = controller
        },
      })
      pending.resolve(new Response(stream, {
        status: message.status,
        statusText: message.statusText,
        headers: message.headers,
      }))
    } else if (message.type === 'response-chunk') {
      pending.controller.enqueue(new Uint8Array(message.chunk))
    } else if (message.type === 'response-end') {
      pending.controller.close()
      this.#pending.delete(message.id)
    }
  }

  #post(message: HostToRuntimeMessage, transfer: Transferable[] = []): void {
    this.#worker.postMessage(message, transfer)
  }
}
