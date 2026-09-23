import { createGuest, type GuestConnection } from './guest'
import type { WorkspaceFiles } from './files'
import { fileCall } from './file-capability'
import { IncomingRequest } from './incoming-request'

export interface ExecutionResult {
  exitCode: number
  stdout: string
  stderr: string
  duration: number
}
export interface ProcessOptions {
  timeoutMs?: number
  env?: Record<string, string>
  argv?: string[]
  writable?: boolean
  onOutput?: (level: string, text: string) => void
}

export class GuestProcess {
  #guest?: GuestConnection
  #controller = new AbortController()
  #pending = new Map<
    number,
    {
      resolve(value: Response): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  #nextId = 1
  #loadReject?: (error: Error) => void
  #closed = false
  #outputBytes = 0
  stdout = ''
  stderr = ''

  constructor(
    readonly fs: WorkspaceFiles,
    readonly options: ProcessOptions = {},
  ) {}

  async load(code: string): Promise<boolean> {
    if (this.#closed) throw new Error('Process closed')
    this.#guest = await createGuest(this.#controller.signal)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.close('Execution timed out'),
        this.options.timeoutMs ?? 5_000,
      )
      this.#loadReject = (error) => {
        clearTimeout(timer)
        reject(error)
      }
      this.#guest!.port.onmessage = async (event) => {
        const message = event.data
        if (message.type === 'fs') {
          try {
            if (this.#closed) throw new Error('Process closed')
            const value = await fileCall(
              this.fs,
              this.options.writable !== false,
              message.method,
              message.args,
            )
            this.#guest?.port.postMessage({
              type: 'fs-result',
              id: message.id,
              value,
            })
          } catch (error) {
            this.#guest?.port.postMessage({
              type: 'fs-result',
              id: message.id,
              error: String(error),
            })
          }
        } else if (message.type === 'output') {
          const text = String(message.text) + '\n'
          this.#outputBytes += new TextEncoder().encode(text).length
          if (this.#outputBytes > 1024 * 1024) {
            this.close('Output quota exceeded')
            return
          }
          if (message.level === 'error' || message.level === 'warn')
            this.stderr += text
          else this.stdout += text
          try {
            this.options.onOutput?.(message.level, text)
          } catch {
            /* Observer errors cannot disrupt execution. */
          }
        } else if (message.type === 'loaded') {
          clearTimeout(timer)
          this.#loadReject = undefined
          resolve(message.hasHandler)
        } else if (message.type === 'error' || message.type === 'boot-error') {
          this.close(message.error)
        } else if (message.type === 'response') {
          const pending = this.#pending.get(message.id)
          if (!pending) return
          clearTimeout(pending.timer)
          this.#pending.delete(message.id)
          try {
            if (message.error) throw new Error(message.error)
            if (message.body.byteLength > 16 * 1024 * 1024)
              throw new Error('Response quota exceeded')
            pending.resolve(
              new Response(
                [204, 205, 304].includes(message.status) ? null : message.body,
                { status: message.status, headers: message.headers },
              ),
            )
          } catch (error) {
            pending.reject(
              error instanceof Error ? error : new Error(String(error)),
            )
          }
        }
      }
      this.#guest!.port.postMessage({
        type: 'load',
        code,
        env: this.options.env ?? {},
        argv: this.options.argv ?? [],
      })
    })
  }

  async fetch(input: string | Request): Promise<Response> {
    if (this.#closed || !this.#guest) throw new Error('Process closed')
    const request = new IncomingRequest(input)
    const body = ['GET', 'HEAD'].includes(request.method)
      ? undefined
      : await request.arrayBuffer()
    if (body && body.byteLength > 16 * 1024 * 1024)
      throw new Error('Request quota exceeded')
    if (this.#closed) throw new Error('Process closed')
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.close('Request timed out'),
        this.options.timeoutMs ?? 5_000,
      )
      this.#pending.set(id, { resolve, reject, timer })
      this.#guest!.port.postMessage({
        type: 'request',
        id,
        url: request.url,
        method: request.method,
        headers: [...request.headers],
        body,
      })
    })
  }

  close(reason = 'Process closed') {
    if (this.#closed) return
    this.#closed = true
    this.#controller.abort()
    this.#guest?.close()
    this.#guest = undefined
    this.#loadReject?.(new Error(reason))
    this.#loadReject = undefined
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    this.#pending.clear()
  }
}
