import {createCompilerWorker} from './worker-factories'
import type { CompileResult, compileProject } from '../compiler/compile'
import type { WorkspaceSnapshot } from './files'

export function compile(
  snapshot: WorkspaceSnapshot,
  entry: string,
  signal: AbortSignal,
  options: Parameters<typeof compileProject>[2] = {},
  assetBaseURL?: string,
): Promise<CompileResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Compilation cancelled'))
    const worker = createCompilerWorker(assetBaseURL)
    let finished = false
    const finish = (error?: Error, result?: CompileResult) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      worker.terminate()
      if (error) reject(error)
      else resolve(result!)
    }
    const abort = () => finish(new Error('Compilation cancelled'))
    let timer = setTimeout(
      () => finish(new Error('Compiler asset loading timed out')),
      120_000,
    )
    signal.addEventListener('abort', abort, { once: true })
    worker.onerror = (event) => finish(new Error(event.message))
    worker.onmessage = (event) => {
      if (finished) return
      if (event.data.type === 'ready') {
        clearTimeout(timer)
        timer = setTimeout(
          () => finish(new Error('Compilation timed out')),
          30_000,
        )
        return
      }
      finish(
        event.data.error ? new Error(event.data.error) : undefined,
        event.data.result,
      )
    }
    worker.postMessage({ snapshot, entry, options })
  })
}
