import VMWorker from './vm.worker?worker'

export interface VMProbeResult {
  ok: boolean
  value: any
  bootMs: number
  executionMs: number
  wasmHeapBytes?: number
}

// A separate feasibility probe, not a Node runtime or a Workspace execution backend yet.
export function probeVM(
  code: string,
  options: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<VMProbeResult> {
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024
  const timeoutMs = options.timeoutMs ?? 100
  if (
    maxBytes < 256 * 1024 ||
    maxBytes > 64 * 1024 * 1024 ||
    timeoutMs < 10 ||
    timeoutMs > 5_000
  )
    throw new Error('Invalid VM probe limits')
  return new Promise((resolve, reject) => {
    const worker = new VMWorker()
    const finish = (result?: VMProbeResult, error?: Error) => {
      clearTimeout(timer)
      worker.terminate()
      error ? reject(error) : resolve(result!)
    }
    const timer = setTimeout(
      () => finish(undefined, new Error('VM worker timed out')),
      10_000,
    )
    worker.onmessage = (event) => finish(event.data)
    worker.onerror = (event) => finish(undefined, new Error(event.message))
    worker.postMessage({ code, maxBytes, timeoutMs })
  })
}
