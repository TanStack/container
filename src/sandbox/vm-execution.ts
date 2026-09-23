import VMWorker from './vm-execution.worker?worker'
import AsyncifyWorker from './vm-asyncify.worker?worker'
import CombinedWorker from './vm-combined.worker?worker'
import type { WorkspaceFiles } from './files'
import { fileCall } from './file-capability'
import type { ExecutionResult, ProcessOptions } from './process'

export interface VMExecutionOptions extends ProcessOptions {
  maxBytes?: number
  /** Opt-in probes: asyncify provides sync fs; quickjs-als preserves native async context. */
  engine?: 'quickjs' | 'asyncify' | 'quickjs-als' | 'quickjs-als-asyncify'
  /** Guest-only Web API implementations, currently available on the combined engine. */
  webAPIs?: boolean
}

export function executeVM(
  code: string,
  files: WorkspaceFiles,
  signal: AbortSignal,
  options: VMExecutionOptions,
): Promise<ExecutionResult> {
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024
  const timeoutMs = options.timeoutMs ?? 5000
  if (options.webAPIs && options.engine !== 'quickjs-als-asyncify') throw new Error('Web APIs require the combined engine')
  if (
    !Number.isFinite(maxBytes) ||
    maxBytes < 256 * 1024 ||
    maxBytes > 64 * 1024 * 1024 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 10 ||
    timeoutMs > 30000
  )
    throw new Error('Invalid VM execution limits')
  if (signal.aborted) throw new Error('Workspace closed')
  const started = performance.now()
  return new Promise((resolve) => {
    const worker =
      options.engine === 'quickjs-als-asyncify' ? new CombinedWorker() : options.engine === 'asyncify' ? new AsyncifyWorker() : new VMWorker()
    let stdout = '',
      stderr = '',
      outputBytes = 0,
      finished = false
    const finish = (error?: string) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      worker.terminate()
      resolve({
        exitCode: error ? 1 : 0,
        stdout,
        stderr: stderr + (error ?? ''),
        duration: performance.now() - started,
      })
    }
    const abort = () => finish('Workspace closed')
    signal.addEventListener('abort', abort, { once: true })
    // Allow engine loading separately from the guest's execution budget.
    const timer = setTimeout(
      () => finish('VM worker timed out'),
      timeoutMs + 10000,
    )
    worker.onerror = (event) => finish(event.message)
    worker.onmessage = async (event) => {
      if (finished) return
      const message = event.data
      if (message.type === 'done') finish()
      else if (message.type === 'error') finish(message.error)
      else if (message.type === 'output') {
        const text = String(message.text) + '\n'
        outputBytes += new TextEncoder().encode(text).byteLength
        if (outputBytes > 1024 * 1024) {
          finish('Output quota exceeded')
          return
        }
        if (['error', 'warn'].includes(message.level)) stderr += text
        else stdout += text
        try {
          options.onOutput?.(message.level, text)
        } catch {
          /* Observer only. */
        }
      } else if (message.type === 'fs') {
        try {
          if (
            typeof message.args !== 'string' ||
            message.args.length > 8 * 1024 * 1024
          )
            throw new Error('VM filesystem message too large')
          const args = JSON.parse(message.args)
          if (!Array.isArray(args))
            throw new Error('Invalid filesystem arguments')
          if (message.method === 'writeFile') {
            const value = args[1]
            if (typeof value === 'string')
              args[1] = new TextEncoder().encode(value)
            else if (
              Array.isArray(value?.bytes) &&
              value.bytes.every(
                (byte: unknown) =>
                  Number.isInteger(byte) &&
                  Number(byte) >= 0 &&
                  Number(byte) <= 255,
              )
            )
              args[1] = Uint8Array.from(value.bytes)
            else throw new Error('Invalid file bytes')
          }
          const value = await fileCall(
            files,
            options.writable !== false,
            message.method,
            args,
          )
          if (!finished)
            worker.postMessage({
              type: 'fs-result',
              id: message.id,
              value: JSON.stringify(
                value instanceof Uint8Array
                  ? { bytes: [...value] }
                  : (value ?? null),
              ),
            })
        } catch (error) {
          if (!finished)
            worker.postMessage({
              type: 'fs-result',
              id: message.id,
              error: String(error),
            })
        }
      }
    }
    worker.postMessage({
      type: 'execute',
      engine: options.engine,
      webAPIs: options.webAPIs === true,
      code,
      maxBytes,
      timeoutMs,
      env: options.env ?? {},
      argv: options.argv ?? [],
    })
  })
}
